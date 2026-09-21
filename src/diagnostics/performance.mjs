let measuring = false;

/** Observe real game frames without forcing GPU synchronization or changing FPS. */
export async function measure(seconds = 5) {
    const player = window["_AWAY_DEBUG_PLAYER_"]?.player;
    if (!player || typeof player.showNextFrame !== "function") throw Error("Load AwayFL first");
    if (measuring) throw Error("A measurement is already running");
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 30) throw Error("Use 1–30 seconds");
    measuring = true;
    const original = player.showNextFrame;
    const samples = [];
    const start = performance.now();
    function observed(...args) {
        const time = performance.now();
        const result = original.apply(this, args);
        samples.push(performance.now() - time);
        return result;
    }
    player.showNextFrame = observed;
    try {
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
        const elapsed = performance.now() - start;
        const gl = player._view.stage.context._gl;
        const extension = gl.getExtension("WEBGL_debug_renderer_info");
        const sorted = [...samples].sort((a, b) => a - b);
        const percentile = fraction => sorted.length
            ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] * 10) / 10
            : null;
        return {
            targetFPS: player.frameRate,
            observedFPS: Math.round(samples.length * 10000 / elapsed) / 10,
            frames: samples.length,
            seconds: Math.round(elapsed / 100) / 10,
            medianFrameWorkMs: percentile(0.5),
            p95FrameWorkMs: percentile(0.95),
            window: [innerWidth, innerHeight],
            render: [gl.drawingBufferWidth, gl.drawingBufferHeight],
            dpr: devicePixelRatio,
            gpu: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
            contextLost: gl.isContextLost(),
            visibility: document.visibilityState,
        };
    } finally {
        if (player.showNextFrame === observed) player.showNextFrame = original;
        measuring = false;
    }
}
