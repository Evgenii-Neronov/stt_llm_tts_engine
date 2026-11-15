using System.Diagnostics;
using System.Text;
using System.Text.Json;

record MicFrame(string Id, string Kind, string? Pcm, string? Language = null);

sealed class OnlineStt : IDisposable
{
    readonly Process worker;
    public OnlineStt()
    {
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("VOICELAB_STT_MODEL")))
            throw new InvalidOperationException("Set VOICELAB_STT_MODEL to the local T-one model directory.");
        var info = new ProcessStartInfo("python") { RedirectStandardInput = true, RedirectStandardOutput = true,
            StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = Encoding.UTF8,
            UseShellExecute = false, CreateNoWindow = true };
        info.Environment["PYTHONUTF8"] = "1";
        info.ArgumentList.Add("-u");
        info.ArgumentList.Add(Path.GetFullPath("online_stt.py"));
        worker = Process.Start(info) ?? throw new InvalidOperationException("Cannot start the online STT worker.");
    }

    public async Task Initialize(CancellationToken ct)
    {
        if (await worker.StandardOutput.ReadLineAsync(ct) != "ready")
            throw new InvalidOperationException("T-one failed to load. Check the model path and sherpa-onnx installation.");
    }

    public async Task<string> Decode(MicFrame frame, CancellationToken ct)
    {
        await worker.StandardInput.WriteLineAsync(JsonSerializer.Serialize(frame,
            JsonSerializerOptions.Web).AsMemory(), ct);
        using var response = JsonDocument.Parse(await worker.StandardOutput.ReadLineAsync(ct) ??
            throw new InvalidOperationException("The online STT worker stopped."));
        if (response.RootElement.TryGetProperty("error", out var error))
            throw new InvalidOperationException(error.GetString());
        return response.RootElement.GetProperty("text").GetString() ?? "";
    }

    public void Dispose()
    {
        try { if (!worker.HasExited) worker.Kill(entireProcessTree: true); }
        finally { worker.Dispose(); }
    }
}
