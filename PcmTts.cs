using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;

sealed class PcmTts(IMemoryCache cache, HttpClient http)
{
    record Clip(int Rate, byte[] Pcm);
    readonly string directory = Path.Combine(AppContext.BaseDirectory, "pcm-cache");

    public async Task Stream(string text, Options options, bool bypass,
        Func<byte[], int, string, Task> emit, CancellationToken ct)
    {
        var isOmniVoice = Languages.IsOmniVoice(options.Voice);
        var endpoint = isOmniVoice
            ? Environment.GetEnvironmentVariable("VOICELAB_OMNIVOICE_TTS") ?? "http://127.0.0.1:5194/pcm"
            : Environment.GetEnvironmentVariable("VOICELAB_PCM_TTS") ?? "http://127.0.0.1:5193/pcm";
        var steps = options.OmniSteps is 8 or 12 or 16 ? options.OmniSteps : 8;
        var key = Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(
            new { endpoint, options.Voice, options.Language, options.Rate, steps = isOmniVoice ? steps : 0, text })));
        if (!bypass && cache.TryGetValue<Clip>(key, out var warm) && warm is not null)
        {
            await emit(warm.Pcm, warm.Rate, "RAM");
            return;
        }
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, key + ".pcm");
        if (!bypass && File.Exists(path))
        {
            var remaining = File.GetLastWriteTimeUtc(path).AddHours(5) - DateTime.UtcNow;
            if (remaining > TimeSpan.Zero)
            {
                var bytes = await File.ReadAllBytesAsync(path, ct);
                if (bytes.Length > 4)
                {
                    var clip = new Clip(BitConverter.ToInt32(bytes), bytes[4..]);
                    Remember(clip, remaining);
                    await emit(clip.Pcm, clip.Rate, "Disk");
                    return;
                }
            }
        }
        using var request = new HttpRequestMessage(HttpMethod.Post, VoiceHub.LocalUri(endpoint))
        {
            Content = new ByteArrayContent(JsonSerializer.SerializeToUtf8Bytes(new { text, voice = options.Voice, language = options.Language, steps, speed = Math.Pow(1.1, options.Rate) }))
        };
        request.Content.Headers.ContentType = new("application/json");
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();
        if (!response.Headers.TryGetValues("X-Sample-Rate", out var rates) ||
            !int.TryParse(rates.FirstOrDefault(), out int rate) || rate is < 8000 or > 96000)
            throw new InvalidOperationException("PCM TTS must return a valid X-Sample-Rate header.");
        using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var capture = new MemoryStream();
        var buffer = new byte[4096];
        int carry = 0;
        while (await stream.ReadAsync(buffer.AsMemory(carry), ct) is int count && count > 0)
        {
            count += carry;
            var aligned = count & ~1;
            if (aligned > 0)
            {
                var chunk = buffer[..aligned];
                capture.Write(chunk);
                await emit(chunk, rate, isOmniVoice ? "OmniVoice" : "PCM");
            }
            carry = count - aligned;
            if (carry != 0) buffer[0] = buffer[aligned];
        }
        if (carry != 0 || capture.Length == 0) throw new InvalidOperationException("Invalid or empty PCM stream.");
        var complete = new Clip(rate, capture.ToArray());
        var temp = path + "." + Guid.NewGuid() + ".tmp";
        try
        {
            await using (var output = File.Create(temp))
            {
                await output.WriteAsync(BitConverter.GetBytes(rate), ct);
                await output.WriteAsync(complete.Pcm, ct);
            }
            ct.ThrowIfCancellationRequested();
            File.Move(temp, path, true);
            Remember(complete, TimeSpan.FromHours(5));
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }

        void Remember(Clip clip, TimeSpan remaining) => cache.Set(key, clip, new MemoryCacheEntryOptions
        {
            Size = clip.Pcm.Length,
            AbsoluteExpirationRelativeToNow = remaining < TimeSpan.FromMinutes(2) ? remaining : TimeSpan.FromMinutes(2)
        });
    }
}
