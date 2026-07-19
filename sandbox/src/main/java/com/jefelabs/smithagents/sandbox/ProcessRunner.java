package com.jefelabs.smithagents.sandbox;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.nio.file.Path;
import java.util.List;

import static java.nio.charset.StandardCharsets.UTF_8;

/** Runs a command in a working directory, capturing stdout, stderr, and exit code. */
final class ProcessRunner {

    private ProcessRunner() {
    }

    static Sandbox.ExecResult run(Path cwd, List<String> command) {
        ProcessBuilder pb = new ProcessBuilder(command);
        if (cwd != null) {
            pb.directory(cwd.toFile());
        }
        try {
            Process process = pb.start();
            // Drain stderr on a separate thread: reading stdout while a full stderr
            // pipe buffer blocks the child is the classic ProcessBuilder deadlock.
            StringBuilder err = new StringBuilder();
            Thread errThread = new Thread(() -> {
                try (BufferedReader r = new BufferedReader(new InputStreamReader(process.getErrorStream(), UTF_8))) {
                    String line;
                    while ((line = r.readLine()) != null) {
                        err.append(line).append('\n');
                    }
                } catch (IOException ignored) {
                    // stream closes when the process exits
                }
            }, "proc-stderr");
            errThread.start();

            String out = new String(process.getInputStream().readAllBytes(), UTF_8);
            errThread.join();
            int code = process.waitFor();
            return new Sandbox.ExecResult(code, out, err.toString());
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to run " + command, e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted running " + command, e);
        }
    }
}
