// Compiled into a console .exe in the test's temporary directory on Windows.
using System;
using System.IO;
using System.Linq;
using System.Reflection;

internal static class FakeCli
{
    public static int Main(string[] args)
    {
        bool claude = Path.GetFileNameWithoutExtension(Assembly.GetExecutingAssembly().Location) == "claude";
        if (args.Contains("--version"))
            Console.WriteLine(claude ? "1.2.3 (Claude Code)" : "codex-cli 1.2.3");
        else if (args.Contains("--help"))
            Console.WriteLine("--print --output-format --safe-mode --permission-mode --tools --disallowedTools --strict-mcp-config --max-turns --no-session-persistence --settings --no-daemon --disable --ask-for-approval --sandbox --ephemeral --skip-git-repo-check --json --model");
        else if (args.Contains("status"))
        {
            if (claude)
                Console.WriteLine("{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"account\":\"OMITTED_MARKER\"}");
            else
                Console.Error.WriteLine("Logged in using ChatGPT");
        }
        else if (args.Contains("features") && args.Contains("list"))
        {
            for (int i = 1; i < args.Length; i++)
                if (args[i - 1] == "--disable") Console.WriteLine(args[i] + " stable false");
        }
        else if (args.Contains("mcp") && args.Contains("list"))
            Console.WriteLine("[]");
        else
        {
            if (Environment.GetEnvironmentVariable("UNLISTED_DEMO") != null || Environment.GetEnvironmentVariable("OPENAI_API_KEY") != null) return 2;
            string system32 = Path.Combine(Environment.GetEnvironmentVariable("SystemRoot"), "System32");
            if (!String.Equals(Environment.GetEnvironmentVariable("PATH"), system32, StringComparison.OrdinalIgnoreCase)) return 7;
            if (Path.GetFileName(Environment.CurrentDirectory) != "working dir") return 3;
            if (!args.Last().StartsWith("Reply with exactly CONCORDIA_OK", StringComparison.Ordinal)) return 4;
            if (claude)
            {
                int tools = Array.IndexOf(args, "--tools");
                if (tools < 0 || tools + 1 >= args.Length || args[tools + 1] != "") return 5;
                int disallowed = Array.IndexOf(args, "--disallowedTools");
                if (disallowed < 0 || disallowed + 1 >= args.Length || args[disallowed + 1] != "*") return 8;
                Console.WriteLine("{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"CONCORDIA_OK\",\"session_id\":\"OMITTED_MARKER\"}");
            }
            else
            {
                int sandbox = Array.IndexOf(args, "--sandbox");
                if (sandbox < 0 || sandbox + 1 >= args.Length || args[sandbox + 1] != "read-only") return 6;
                if (!args.Contains("--json")) return 9;
                Console.WriteLine("{\"type\":\"thread.started\",\"thread_id\":\"OMITTED_MARKER\"}");
                Console.WriteLine("{\"type\":\"turn.started\"}");
                Console.WriteLine("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"CONCORDIA_OK\"}}");
                Console.WriteLine("{\"type\":\"turn.completed\"}");
            }
        }
        return 0;
    }
}
