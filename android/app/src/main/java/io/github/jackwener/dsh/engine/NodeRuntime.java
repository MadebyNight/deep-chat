package io.github.jackwener.dsh.engine;

public final class NodeRuntime {
    static {
        System.loadLibrary("c++_shared");
        System.loadLibrary("node");
        System.loadLibrary("dshengine");
    }

    private NodeRuntime() {}

    public static native int nativeStart(String[] args, int stdinFd, int stdoutFd, int stderrFd);
}
