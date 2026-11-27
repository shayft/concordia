// Native Windows fixture. The only outbound HTTP target is this test's loopback MCP endpoint.
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;

internal static class CrashCli
{
    static readonly string Exe = Assembly.GetExecutingAssembly().Location;
    static void Hold(int depth)
    {
        File.WriteAllText(Path.Combine(Path.GetDirectoryName(Exe), "pid-" + depth), Process.GetCurrentProcess().Id.ToString());
        if (depth < 2) {
            var child = new ProcessStartInfo(Exe) { UseShellExecute = false };
            child.EnvironmentVariables.Remove("CONCORDIA_MCP_TOKEN");
            child.EnvironmentVariables["CONCORDIA_FIXTURE_DEPTH"] = (depth + 1).ToString();
            Process.Start(child);
        }
        Thread.Sleep(120000);
    }
    public static int Main(string[] args)
    {
        int depth;
        if (Int32.TryParse(Environment.GetEnvironmentVariable("CONCORDIA_FIXTURE_DEPTH"), out depth)) {
            Hold(depth);
            return 0;
        }
        var match = Regex.Match(String.Join("\n", args), "url=\u0022(http://127[.]0[.]0[.]1:[0-9]+/mcp/[a-zA-Z0-9_-]+)\u0022");
        string url = match.Success ? match.Groups[1].Value : null;
        if (args.Contains("--version")) Console.WriteLine("codex-cli 0.171.0");
        else if (args.Contains("--help")) Console.WriteLine("--no-daemon --disable --ask-for-approval --sandbox --ephemeral --skip-git-repo-check --json resume --model");
        else if (args.Contains("features")) {
            for (int i=1; i<args.Length; i++) if(args[i-1]=="--disable") Console.WriteLine(args[i]+" stable false");
        }
        else if (args.Contains("list")) Console.WriteLine(url==null ? "[]" :
            "[{\"name\":\"concordia\",\"enabled\":true,\"transport\":{\"type\":\"streamable_http\",\"url\":\""+url+"\",\"bearer_token_env_var\":\"CONCORDIA_MCP_TOKEN\"}}]");
        else if (args.Contains("status")) Console.WriteLine("Logged in using ChatGPT");
        else {
            if (url==null || !args.Contains("read-only")) return 2;
            using(var http=new WebClient()) {
                http.Proxy=null;
                foreach (var payload in new[] {
                    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"fixture\",\"version\":\"1\"}}}",
                    "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"publish_artifact\",\"arguments\":{\"slotId\":\"contract\",\"content\":\"public fixture v1\"}}}"
                }) {
                    http.Headers["Authorization"]="Bearer "+Environment.GetEnvironmentVariable("CONCORDIA_MCP_TOKEN");
                    http.Headers["Content-Type"]="application/json";
                    var response=http.UploadString(url,"POST",payload);
                    if (!response.Contains("\"result\"") || response.Contains("\"isError\":true")) return 3;
                }
            }
            Hold(0);
        }
        return 0;
    }
}
