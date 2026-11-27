// Each generation stays in Concordia's console and Job. Spawning with
// ProcessStartInfo avoids libuv's separate kill-on-parent-exit job.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;

internal static class WindowsProcessTree
{
    public static int Main()
    {
        int depth = int.Parse(Environment.GetEnvironmentVariable("CONCORDIA_FIXTURE_DEPTH") ?? "0");
        Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e)
        {
            if (e.SpecialKey != ConsoleSpecialKey.ControlBreak) return;
            File.WriteAllText("stopped-" + depth, "SIGBREAK");
            e.Cancel = depth == 2; // The leaf stays alive until job closure.
        };
        File.WriteAllText("pid-" + depth, Process.GetCurrentProcess().Id.ToString());
        if (depth < 2)
        {
            var start = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location);
            start.UseShellExecute = false;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.EnvironmentVariables["CONCORDIA_FIXTURE_DEPTH"] = (depth + 1).ToString();
            // Neither descendant holds the verifier's output pipes.
            Process.Start(start).Dispose();
        }
        else
        {
            File.WriteAllText("leaf-ready", "");
        }

        while (depth != 0 || !File.Exists("release-root")) Thread.Sleep(10);
        return 23;
    }
}
