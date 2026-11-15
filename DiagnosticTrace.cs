using System.Text.Json;
using System.Threading.Channels;

sealed class DiagnosticTrace(ILogger<DiagnosticTrace> logger) : BackgroundService
{
    public static readonly string DirectoryPath = Path.Combine(AppContext.BaseDirectory, "traces");
    readonly Channel<TraceEntry> entries = Channel.CreateBounded<TraceEntry>(new BoundedChannelOptions(2048)
    {
        SingleReader = true,
        FullMode = BoundedChannelFullMode.DropOldest
    });
    readonly bool includeText = Environment.GetEnvironmentVariable("VOICELAB_TRACE_TEXT") == "1";

    record TraceEntry(DateTimeOffset Time, string Session, string? Turn, string Event, object? Data);

    public string? Text(string? value) => includeText ? value : null;

    public void Write(string session, string? turn, string name, object? data = null) =>
        entries.Writer.TryWrite(new(DateTimeOffset.UtcNow, session, turn, name, data));

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        StreamWriter? output = null;
        string? day = null;
        try
        {
            await foreach (var item in entries.Reader.ReadAllAsync(stoppingToken))
            {
                var date = item.Time.ToString("yyyy-MM-dd");
                if (date != day)
                {
                    if (output is not null) await output.DisposeAsync();
                    Directory.CreateDirectory(DirectoryPath);
                    output = File.AppendText(Path.Combine(DirectoryPath, "trace-" + date + ".jsonl"));
                    day = date;
                }
                await output!.WriteLineAsync(JsonSerializer.Serialize(item, JsonSerializerOptions.Web));
                if (!entries.Reader.TryPeek(out _)) await output.FlushAsync(stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        catch (Exception error) { logger.LogError(error, "VoiceLab diagnostic trace writer failed."); }
        finally { if (output is not null) await output.DisposeAsync(); }
    }
}
