using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Channels;
using Microsoft.AspNetCore.SignalR;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://127.0.0.1:5188");
builder.Services.AddSignalR(options => { options.MaximumReceiveMessageSize = 6 * 1024 * 1024; options.MaximumParallelInvocationsPerClient = 8; options.StreamBufferCapacity = 128; });
builder.Services.AddMemoryCache(options => options.SizeLimit = 64 * 1024 * 1024);
builder.Services.AddSingleton<PcmTts>();
builder.Services.AddSingleton<ActiveResponses>();
builder.Services.AddSingleton(new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false })
    { Timeout = TimeSpan.FromSeconds(15) });
var app = builder.Build();
app.Use(async (context, next) =>
{
    var origin = context.Request.Headers.Origin.ToString();
    if (context.Request.Path.StartsWithSegments("/voice") &&
        origin.Length != 0 && origin != "http://127.0.0.1:5188")
    {
        context.Response.StatusCode = 403;
        return;
    }
    await next(context);
});
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapHub<VoiceHub>("/voice");
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.MapGet("/prompts/{name}", async (string name, string? label, HttpClient http, CancellationToken ct) =>
{
    var publicKey = Environment.GetEnvironmentVariable("LANGFUSE_PUBLIC_KEY");
    var secretKey = Environment.GetEnvironmentVariable("LANGFUSE_SECRET_KEY");
    if (string.IsNullOrWhiteSpace(publicKey) || string.IsNullOrWhiteSpace(secretKey))
        return Results.BadRequest("Задай LANGFUSE_PUBLIC_KEY и LANGFUSE_SECRET_KEY перед запуском.");
    var address = "http://127.0.0.1:3000/api/public/v2/prompts/" + Uri.EscapeDataString(name) +
        "?label=" + Uri.EscapeDataString(label ?? "production");
    using var request = new HttpRequestMessage(HttpMethod.Get, address);
    request.Headers.Authorization = new("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes(publicKey + ":" + secretKey)));
    try
    {
        using var response = await http.SendAsync(request, ct);
        return Results.Content(await response.Content.ReadAsStringAsync(ct), "application/json", statusCode: (int)response.StatusCode);
    }
    catch (HttpRequestException) { return Results.Problem("Локальный Langfuse недоступен на порту 3000.", statusCode: 503); }
});
app.Run();

record Options(string Language, string Device, string Endpoint, string Model, double Temperature,
    int MaxTokens, string Voice, int Rate, string Prompt, Dictionary<string,string> Variables, bool Diagnostic, string? HomeLanguage = null, Dictionary<string,string>? VoicePreferences = null);
record Message(string Role, string Content);

sealed class ActiveResponses : ConcurrentDictionary<(string Connection, string Id), CancellationTokenSource>;

sealed class VoiceHub(PcmTts tts, ActiveResponses responses, HttpClient http) : Hub
{
    // Keep the control vocabulary out of normal prompts, where a small model can copy it.
    static readonly Regex LanguageRequest = new(
        @"язык|по[- ]?(русски|английски|немецки|французски|тагалог)|на (русск|английск|немецк|французск|филиппинск|филипинск|тагалог)|language|english|german|french|russian|filipino|tagalog|sprache|deutsch|englisch|französisch|russisch|langue|anglais|allemand|français|russe|wika|ingles|espanyol|wikang",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    public async Task Interrupt(string id)
    {
        if (responses.TryGetValue((Context.ConnectionId, id), out var response))
        {
            try { await response.CancelAsync(); }
            catch (ObjectDisposedException) { }
        }
    }

    public async Task Listen(IAsyncEnumerable<MicFrame> frames)
    {
        var ct = Context.ConnectionAborted;
        using var worker = new OnlineStt();
        await worker.Initialize(ct);
        await Clients.Caller.SendAsync("mic", new { kind = "ready", id = "", text = "" }, ct);
        string? active = null;
        string previous = "";
        await foreach (var frame in frames.WithCancellation(ct))
        {
            if (frame.Kind == "prepare")
            {
                var code = Languages.Parse(frame.Language).Code();
                try
                {
                    await worker.Decode(frame with { Language = code }, ct);
                    await Clients.Caller.SendAsync("mic", new { kind = "prepared", id = frame.Id, text = code }, ct);
                }
                catch (InvalidOperationException error)
                {
                    await Clients.Caller.SendAsync("mic", new { kind = "error", id = frame.Id, text = error.Message }, ct);
                }
                continue;
            }
            if (frame.Kind == "start")
            {
                active = frame.Id;
                previous = "";
            }
            else if (frame.Id != active || frame.Kind is not ("audio" or "final")) continue;

            string text;
            try { text = await worker.Decode(frame with { Language = Languages.Parse(frame.Language).Code() }, ct); }
            catch (InvalidOperationException error)
            {
                active = null;
                await Clients.Caller.SendAsync("mic", new { kind = "error", id = frame.Id, text = error.Message }, ct);
                continue;
            }
            if (frame.Kind == "final" || text != previous)
                await Clients.Caller.SendAsync("mic", new
                {
                    id = frame.Id, kind = frame.Kind == "final" ? "final" : "partial", text
                }, ct);
            previous = text;
            if (frame.Kind == "final") active = null;
        }
    }

    public async Task Run(string id, string text, string? pcm, string mode, Options options, Message[] history)
    {
        var disconnected = Context.ConnectionAborted;
        using var responseCancellation = CancellationTokenSource.CreateLinkedTokenSource(disconnected);
        responseCancellation.CancelAfter(TimeSpan.FromMinutes(2));
        var key = (Context.ConnectionId, id);
        if (!responses.TryAdd(key, responseCancellation)) return;
        var ct = responseCancellation.Token;
        var client = Clients.Caller;
        var clock = Stopwatch.StartNew();
        Task Event(string stage, string kind, string? data = null, int part = 0, int rate = 0) =>
            client.SendAsync("event", new { id, stage, kind, data, part, rate, ms = clock.Elapsed.TotalMilliseconds }, disconnected);

        var currentLanguage = Languages.Parse(options.Language);
        var homeLanguage = Languages.Parse(options.HomeLanguage ?? options.Language);
        var replyLanguage = currentLanguage;
        options = options with { Language = currentLanguage.Code() };
        try
        {
            if (pcm is not null && mode != "tts")
            {
                await Event("stt", "start");
                using var worker = new OnlineStt();
                await worker.Initialize(ct);
                await worker.Decode(new MicFrame(id, "start", null, currentLanguage.Code()), ct);
                var audio = Convert.FromBase64String(pcm);
                bool firstResult = true;
                for (int offset = 0; offset < audio.Length; offset += 1280)
                {
                    var partial = await worker.Decode(new MicFrame(id, "audio",
                        Convert.ToBase64String(audio, offset, Math.Min(1280, audio.Length - offset))), ct);
                    if (firstResult && !string.IsNullOrWhiteSpace(partial))
                    {
                        await Event("stt", "first");
                        firstResult = false;
                    }
                }
                text = await worker.Decode(new MicFrame(id, "final", null), ct);
                if (firstResult && !string.IsNullOrWhiteSpace(text)) await Event("stt", "first");
                await Event("stt", "end", text);
                if (mode is "stt" or "partial" || string.IsNullOrWhiteSpace(text)) return;
            }
            if (mode == "tts")
            {
                await Synthesize(text, 1, true);
                return;
            }

            await Event("llm", "start");
            using var turn = CancellationTokenSource.CreateLinkedTokenSource(ct);
            turn.CancelAfter(TimeSpan.FromMinutes(2));
            var queue = Channel.CreateBounded<string>(32);
            var consumer = PlayQueue();
            var buffer = new StringBuilder();
            var control = new StringBuilder();
            bool checkingControl = true;
            bool switched = false;
            bool first = true;
            bool firstPhrase = true;
            try
            {
                if (options.Diagnostic)
                    await Delta("Проверка тракта. " + text);
                else
                {
                    var endpoint = LocalUri(options.Endpoint);
                    var prompt = Regex.Replace(options.Prompt, @"\{\{\s*([\w.-]+)\s*\}\}",
                        m => m.Groups[1].Value switch
                        {
                            "language" => currentLanguage.Name(),
                            "home_language" => homeLanguage.Name(),
                            var key => options.Variables.GetValueOrDefault(key, m.Value)
                        });
                    var conversation = $"Reply in {currentLanguage.Name()}. Use the previous conversation to answer the latest user message. If asked to continue, pick up where your last answer ended.";
                    if (!LanguageRequest.IsMatch(text)) checkingControl = false;
                    var protocol = $"""
                        VOICE LANGUAGE PROTOCOL. Current language: {currentLanguage.Name()} ({currentLanguage.Code()}).
                        Original language: {homeLanguage.Name()} ({homeLanguage.Code()}).
                        Use earlier user and assistant messages for facts, references, and continuations.
                        Continue from where the last assistant message left off when asked to continue.
                        By default, reply naturally in the current language. Do not output a marker for an ordinary request.
                        When the user explicitly asks to switch the conversation language, begin with exactly one control line:
                        @LANG:ru, @LANG:en, @LANG:de, @LANG:fr, or @LANG:tl (Filipino/Tagalog).
                        When the user asks to return to the original or initial language, begin with @LANG:home.
                        On a switch request, output only the matching control line. The application speaks a localized confirmation.
                        For example: "Switch to English" -> @LANG:en; "Wechseln wir ins Französische" -> @LANG:fr;
                        "Bumalik tayo sa orihinal na wika" -> @LANG:home.
                        Language mentions or requests to translate a phrase alone never change the conversation language.
                        Only these five languages are supported; explain unsupported requests in the current language.
                        """;
                    var messages = new[] { new Message("system", prompt + "\n\n" + conversation + (checkingControl ? "\n\n" + protocol : "")) }
                        .Concat(history.Where(m => m.Role is "user" or "assistant").TakeLast(16))
                        .Append(new Message("user", text));
                    using var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
                    {
                        Content = JsonContent.Create(new { model = options.Model, messages, stream = true,
                            temperature = options.Temperature, max_tokens = options.MaxTokens,
                            cache_prompt = true, chat_template_kwargs = new { enable_thinking = false } })
                    };
                    using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, turn.Token);
                    response.EnsureSuccessStatusCode();
                    using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(turn.Token));
                    while (await reader.ReadLineAsync(turn.Token) is { } line)
                    {
                        if (!line.StartsWith("data:")) continue;
                        var json = line[5..].Trim();
                        if (json == "[DONE]") break;
                        using var doc = JsonDocument.Parse(json);
                        if (doc.RootElement.TryGetProperty("choices", out var choices) && choices.GetArrayLength() > 0 &&
                            choices[0].TryGetProperty("delta", out var delta) &&
                            delta.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.String)
                            await Delta(content.GetString()!);
                        if (switched) break;
                    }
                }
                if (checkingControl) await ParseControl("", finished: true);
                if (first) throw new InvalidOperationException("LLM вернул пустой поток текста.");
                await Event("llm", "end");
                if (buffer.Length > 0) await queue.Writer.WriteAsync(buffer.ToString(), turn.Token);
            }
            finally
            {
                queue.Writer.TryComplete();
                await consumer;
            }

            async Task Delta(string value)
            {
                if (checkingControl) await ParseControl(value);
                else await SpokenDelta(value);
            }

            async Task ParseControl(string value, bool finished = false)
            {
                control.Append(value);
                var pending = control.ToString().TrimStart();
                const string prefix = "@LANG:";
                if (pending.Length == 0 && !finished) return;
                if (!finished && pending.Length < prefix.Length &&
                    prefix.StartsWith(pending, StringComparison.OrdinalIgnoreCase)) return;
                if (!pending.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                {
                    checkingControl = false;
                    await SpokenDelta(control.ToString());
                    return;
                }
                var newline = pending.IndexOf('\n');
                if (newline < 0 && !finished && pending.Length <= 32) return;
                var code = pending[prefix.Length..(newline < 0 ? pending.Length : newline)].Trim();
                var isHome = code.Equals("home", StringComparison.OrdinalIgnoreCase);
                if (Languages.TryParse(code, out var target) || isHome)
                {
                    replyLanguage = isHome ? homeLanguage : target;
                    await Event("language", "switch", replyLanguage.Code());
                    switched = true;
                    checkingControl = false;
                    await SpokenDelta(replyLanguage.Acknowledge());
                    return;
                }
                checkingControl = false;
                if (newline >= 0) await SpokenDelta(pending[(newline + 1)..].TrimStart());
            }

            async Task SpokenDelta(string value)
            {
                if (value.Length == 0) return;
                if (first) { await Event("llm", "first"); first = false; }
                await Event("llm", "delta", value);
                foreach (var ch in value)
                {
                    buffer.Append(ch);
                    if ((buffer.Length >= (firstPhrase ? 8 : 24) && ".!?,;:".Contains(ch)) || (buffer.Length >= (firstPhrase ? 28 : 105) && char.IsWhiteSpace(ch)))
                    {
                        await queue.Writer.WriteAsync(buffer.ToString().Trim(), turn.Token);
                        buffer.Clear();
                        firstPhrase = false;
                    }
                }
            }

            async Task PlayQueue()
            {
                int part = 0;
                try
                {
                    await foreach (var phrase in queue.Reader.ReadAllAsync(turn.Token))
                        await Synthesize(phrase, ++part, false);
                }
                catch { turn.Cancel(); throw; }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            if (!disconnected.IsCancellationRequested) await Event("turn", "cancel");
        }
        catch (Exception e) when (!disconnected.IsCancellationRequested) { await Event("turn", "error", e.Message); }
        finally
        {
            responses.TryRemove(key, out _);
            if (!disconnected.IsCancellationRequested) await Event("turn", "end");
        }

        async Task Synthesize(string phrase, int part, bool bypass)
        {
            await Event("tts", "start", null, part);
            bool firstChunk = true;
            await tts.Stream(phrase, options with { Voice = replyLanguage.Voice(options.VoicePreferences?.GetValueOrDefault(replyLanguage.Code()) ?? options.Voice) }, bypass, async (bytes, rate, source) =>
            {
                ct.ThrowIfCancellationRequested();
                if (firstChunk) { await Event("tts", "first", source, part); firstChunk = false; }
                await Event("tts", "audio", Convert.ToBase64String(bytes), part, rate);
            }, ct);
            await Event("tts", "end", null, part);
        }
    }

    internal static Uri LocalUri(string address)
    {
        if (Uri.TryCreate(address, UriKind.Absolute, out var uri) &&
            uri.Scheme == "http" && IPAddress.TryParse(uri.Host.Trim('[', ']'), out var host) && IPAddress.IsLoopback(host))
            return uri;
        throw new InvalidOperationException("Укажи локальный HTTP URL с IP 127.0.0.1.");
    }
}
