// Opt-in, bounded diagnostic on this renderer only. No readPixels/finish or
// synchronous GPU waits. All hooks and timer queries are released afterwards.
export function createRenderProfiler(renderer, stats, describeGroup = () => ({}), player) {
  let cancel, enterSection;
  return {
    stop() { cancel?.("renderer stopped"); },
    // No clocks or scope allocations outside an explicit profile.
    section(name) { return enterSection?.(name); },
    sample(count = 12, { pickTree = false } = {}) {
      if (cancel) return Promise.reject(Error("A render profile is already running"));
      if (!Number.isInteger(count) || count < 1 || count > 60)
        return Promise.reject(Error("Choose 1–60 rendered frames"));
      const gl = renderer.gl;
      const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
      const frames = [], restore = [];
      const ticks = [];
      let activeTick, activeAdapter, lastTickStart, scope;
      const cpuKeys = ["inputMs", "inputPickMs", "inputTraverseMs",
        "inputCollectMs", "inputCollisionMs", "timelineMs", "timelineAdvanceMs",
        "timelineBroadcastMs", "runtimeBindingsMs", "runtimeOtherMs",
        "syncSetupMs", "syncVisitMs", "syncNativeMs", "syncShapeMs", "syncMasksMs", "syncRetireMs", "syncSceneryMs",
        "syncBindingsMs", "pixiRenderMs", "adapterCleanupMs", "adapterOtherMs"];
      const newCpu = () => Object.fromEntries(cpuKeys.map(key => [key, 0]));
      const groups = new Map(), effects = new Map(), batchOwners = new WeakMap();
      const pickTypes = new Map();
      const pickNodes = { visited: 0, accepted: 0, rejected: 0,
        leaves: 0, containers: 0, pickObjects: 0 };
      const updateCounts = new WeakMap();
      for (const batches of Object.values(renderer.renderPipes.batch._batchersByInstructionSet || {}))
        for (const batch of Object.values(batches))
          updateCounts.set(batch, [batch.unchangedUpdates || 0, batch.packedUpdates || 0]);
      let updatingGroup, executingGroup;
      function groupInfo(group) {
        const id = group.instructionSet.uid;
        if (!groups.has(id)) groups.set(id, { id, ...describeGroup(group.root),
          updateMs: 0, rebuilds: 0, uploads: 0, uploadBytes: 0, draws: 0, triangles: 0,
          vertexBytes: 0, changedBytes: 0, unchangedUpdates: 0, packedUpdates: 0 });
        return groups.get(id);
      }
      function effectInfo(filter) {
        const name = filter?.constructor?.name || "UnknownFilter";
        if (!effects.has(name)) effects.set(name, {
          name, passes: 0, targetPixels: 0, quadPixels: 0, submitMs: 0, draws: 0,
        });
        return effects.get(name);
      }
      let current, activeEffect, depth = 0, poll, done = false, disjoint = false;
      enterSection = name => {
        const cpu = activeTick?.cpu || activeAdapter?.cpu;
        if (!cpu || done) return;
        if (name === "bindings") name = activeAdapter ? "syncBindingsMs" : "runtimeBindingsMs";
        const parent = scope, start = performance.now();
        const own = scope = { children: 0, cpu };
        return () => {
          const elapsed = performance.now() - start;
          scope = parent;
          if (parent?.cpu === cpu) parent.children += elapsed;
          if (!done) cpu[name] += Math.max(0, elapsed - own.children);
        };
      };
      const started = performance.now();
      const hover = { hz: stats.idleHoverHz || 0, retained: !!stats.retainedHover, checks: 0, skips: 0 };
      const pickBounds = { enabled: !!stats.configuration?.pixiPickBounds,
        checks: 0, skips: 0, ms: 0 };
      const pickEvents = { enabled: !!stats.configuration?.pixiEvents,
        picks: 0, hits: 0, fallbacks: 0 };
      const configuration = { mode: stats.mode ?? null, ...stats.configuration };
      const snapshotScenery = () => Object.fromEntries([
        "sceneryCaches", "sceneryCandidates", "sceneryWarming", "sceneryRejected",
        "sceneryBuilds", "sceneryPixels",
      ].map(key => [key, stats[key] || 0]));
      const sceneryStart = snapshotScenery();
      function hook(object, key, wrap) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        const original = object[key], wrapper = wrap(original);
        object[key] = wrapper;
        restore.push(() => {
          if (object[key] !== wrapper) return;
          if (descriptor) Object.defineProperty(object, key, descriptor);
          else delete object[key];
        });
      }
      return new Promise(resolve => {
        function finish(reason) {
          if (done) return;
          done = true; clearTimeout(poll);
          for (const undo of restore.reverse()) undo();
          for (const frame of frames) {
            if (frame.query) gl.deleteQuery(frame.query);
            delete frame.query;
            if (disjoint) frame.gpuMs = null;
          }
          const percentile = (samples, key, fraction) => {
            const values = samples.map(f => f[key]).filter(Number.isFinite).sort((a,b) => a-b);
            if (fraction !== 0.5) return values.length ? values[Math.ceil(values.length * fraction) - 1] : null;
            const middle = Math.floor(values.length / 2);
            return !values.length ? null : values.length % 2 ? values[middle]
              : (values[middle - 1] + values[middle]) / 2;
          };
          const metrics = ["syncMs", "renderMs", "batchUpdateMs", "gpuMs", "draws", "triangles", "uploadBytes", "blitPixels", "filterTargetPixels", "filterQuadPixels", "filterPasses", "sceneryCaches", "batchGroups", "preparedContents", "retainedContents", "unchangedUpdates", "packedUpdates", "frameWorkMs", "runtimeMs", "adapterMs", "frameIntervalMs"];
          const tickMetrics = ["frameWorkMs", "runtimeMs", "adapterMs", "frameIntervalMs"];
          const summarize = (samples, keys, fraction) => Object.fromEntries(keys.map(k => [k, percentile(samples, k, fraction)]));
          const mean = (samples, keys) => Object.fromEntries(keys.map(k => {
            const values = samples.map(f => f[k]).filter(Number.isFinite);
            return [k, values.length ? values.reduce((a,b) => a+b, 0) / values.length : null];
          }));
          cancel = null; enterSection = null;
          resolve({ reason, timerSupported: !!ext, disjoint, renderSize: [...stats.renderSize],
            configuration, scenery: { start: sceneryStart, end: snapshotScenery() },
            hover,
            pickBounds,
            pickEvents,
            pickTree: pickTree ? { ...pickNodes,
              types: [...pickTypes].map(([type, count]) => ({ type, count }))
                .sort((a, b) => b.count - a.count) } : null,
            // Totals cover the entire sample; timings exclude child group updates.
            groups: [...groups.values()].sort((a,b) => b.uploadBytes-a.uploadBytes),
            // Viewport and output-quad area are workload proxies, not GPU
            // timers. The single elapsed query still measures the whole frame.
            effects: [...effects.values()].sort((a,b) => b.quadPixels-a.quadPixels),
            median: summarize(frames, metrics, 0.5), p95: summarize(frames, metrics, 0.95),
            // Exclusive sections partition frame work (or a manual adapter call).
            // Use ticks when available so reused canvas frames are included.
            cpu: {
              basis: ticks.length ? "native-ticks" : "manual-draws",
              mean: mean((ticks.length ? ticks : frames).map(f => f.cpu), cpuKeys),
              median: summarize((ticks.length ? ticks : frames).map(f => f.cpu), cpuKeys, 0.5),
              p95: summarize((ticks.length ? ticks : frames).map(f => f.cpu), cpuKeys, 0.95),
            },
            frameTiming: {
              targetFPS: player?.frameRate ?? null, ticks: ticks.length,
              ticksWithoutDraw: ticks.filter(t => !t.draws).length,
              observedFPS: ticks.length > 1 && ticks.at(-1).start > ticks[0].start
                ? (ticks.length - 1) * 1000 / (ticks.at(-1).start - ticks[0].start) : null,
              median: summarize(ticks, tickMetrics, 0.5), p95: summarize(ticks, tickMetrics, 0.95),
            }, frames });
        }
        cancel = finish;
        if (typeof player?.showNextFrame === "function") {
          hook(player, "showNextFrame", original => function (...args) {
            if (this.isPaused || activeTick || frames.length >= count || ticks.length >= 2048)
              return original.apply(this, args);
            const start = performance.now();
            const tick = { start, adapterMs: 0, draws: 0, frames: [], cpu: newCpu(),
              frameIntervalMs: lastTickStart === undefined ? null : start - lastTickStart };
            lastTickStart = start; activeTick = tick;
            const end = enterSection("runtimeOtherMs");
            try { return original.apply(this, args); }
            finally {
              end?.();
              activeTick = null;
              if (!done) {
                tick.frameWorkMs = performance.now() - start;
                tick.runtimeMs = Math.max(0, tick.frameWorkMs - tick.adapterMs);
                for (const frame of tick.frames) Object.assign(frame, {
                  frameWorkMs: tick.frameWorkMs, runtimeMs: tick.runtimeMs,
                  frameIntervalMs: tick.frameIntervalMs,
                });
                ticks.push(tick);
              }
            }
          });
          // Covers synchronization, Pixi submission and adapter cleanup. The
          // remainder of showNextFrame includes input, timelines, AS and sound.
          hook(player._renderer, "render", original => function (...args) {
            if (activeAdapter || frames.length >= count) return original.apply(this, args);
            const start = performance.now(), adapter = { frames: [], cpu: activeTick?.cpu || newCpu() };
            activeAdapter = adapter;
            const end = enterSection("adapterOtherMs");
            try { return original.apply(this, args); }
            finally {
              end?.();
              activeAdapter = null;
              const elapsed = performance.now() - start;
              if (activeTick) activeTick.adapterMs += elapsed;
              if (!done) for (const frame of adapter.frames) frame.adapterMs = elapsed;
            }
          });
        }
        for (const [object, method, name] of [
          [player?._mouseManager, "fireMouseEvents", "inputMs"],
          [player?._avmHandler, "enterFrame", "timelineMs"],
          [player?._mousePicker, "getViewCollision", "inputPickMs"],
          [player?._mousePicker, "traverse", "inputTraverseMs"],
          [player?._mousePicker, "_collectEntities", "inputCollectMs"],
          [player?._mousePicker, "_getPickingCollision", "inputCollisionMs"],
          [player?._avmHandler?._playerglobal?._stage?.adaptee, "advanceFrame", "timelineAdvanceMs"],
          [player?._avmHandler?._playerglobal?._stage, "dispatchStaticBroadCastEvent", "timelineBroadcastMs"],
        ]) if (typeof object?.[method] === "function") {
          hook(object, method, original => function (...args) {
            const countingHover = activeTick && method === "fireMouseEvents";
            const countingBounds = activeTick && method === "getViewCollision";
            const checks = countingHover ? stats.hoverChecks || 0 : 0;
            const skips = countingHover ? stats.hoverSkips || 0 : 0;
            const boundChecks = countingBounds ? stats.pixiPickBoundsChecks || 0 : 0;
            const boundSkips = countingBounds ? stats.pixiPickBoundsSkips || 0 : 0;
            const boundMs = countingBounds ? stats.pixiPickBoundsMs || 0 : 0;
            const eventPicks = countingBounds ? stats.pixiEventPicks || 0 : 0;
            const eventHits = countingBounds ? stats.pixiEventHits || 0 : 0;
            const eventFallbacks = countingBounds ? stats.pixiEventFallbacks || 0 : 0;
            const end = activeTick && enterSection?.(name);
            try { return original.apply(this, args); }
            finally {
              end?.();
              if (countingHover && !done) {
                hover.checks += (stats.hoverChecks || 0) - checks;
                hover.skips += (stats.hoverSkips || 0) - skips;
              }
              if (countingBounds && !done) {
                pickBounds.checks += (stats.pixiPickBoundsChecks || 0) - boundChecks;
                pickBounds.skips += (stats.pixiPickBoundsSkips || 0) - boundSkips;
                pickBounds.ms += (stats.pixiPickBoundsMs || 0) - boundMs;
                pickEvents.picks += (stats.pixiEventPicks || 0) - eventPicks;
                pickEvents.hits += (stats.pixiEventHits || 0) - eventHits;
                pickEvents.fallbacks += (stats.pixiEventFallbacks || 0) - eventFallbacks;
              }
            }
          });
        }
        // A separate opt-in sample counts nodes reached by every nested
        // RaycastPicker. Instrumenting enterNode affects timing, so normal
        // profiles do not install this hook.
        const pickerPrototype = player?._mousePicker
          ? Object.getPrototypeOf(player._mousePicker) : null;
        if (pickTree && typeof pickerPrototype?.enterNode === "function")
          hook(pickerPrototype, "enterNode", original => function (node, ...args) {
            if (activeTick) {
              pickNodes.visited++;
              const type = node?.container?.assetType || "unknown";
              pickTypes.set(type, (pickTypes.get(type) || 0) + 1);
              if (node?._numChildNodes) pickNodes.containers++;
              else pickNodes.leaves++;
              if (node?.pickObjectNode) pickNodes.pickObjects++;
            }
            const accepted = original.call(this, node, ...args);
            if (activeTick) pickNodes[accepted ? "accepted" : "rejected"]++;
            return accepted;
          });
        for (const name of ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced"])
          hook(gl, name, original => function (...args) {
            if (current) {
              current.draws++;
              if (executingGroup) executingGroup.draws++;
              if (activeEffect) activeEffect.draws++;
              const vertices = name.startsWith("drawElements") ? args[1] : args[2];
              const instances = name.endsWith("Instanced") ? args.at(-1) : 1;
              if (args[0] === gl.TRIANGLES) {
                current.triangles += vertices * instances / 3;
                if (executingGroup) executingGroup.triangles += vertices * instances / 3;
              }
            }
            return original.apply(this, args);
          });
        for (const name of ["bufferData", "bufferSubData"])
          hook(gl, name, original => function (...args) {
            const data = args[name === "bufferData" ? 1 : 2];
            if (current && data?.byteLength) {
              const offset = args[3] || 0, length = args[4];
              const bytes = name === "bufferData" ? data.byteLength
                : (length || (data.length - offset)) * (data.BYTES_PER_ELEMENT || 1);
              current.uploadBytes += bytes;
              if (executingGroup) { executingGroup.uploadBytes += bytes; executingGroup.uploads++; }
            }
            return original.apply(this, args);
          });
        hook(gl, "blitFramebuffer", original => function (...a) {
          if (current) current.blitPixels += Math.abs((a[2]-a[0])*(a[3]-a[1]));
          return original.apply(this, a);
        });
        if (typeof renderer.filter?._setupBindGroupsAndRender === "function")
          hook(renderer.filter, "_setupBindGroupsAndRender", original => function (filter, ...args) {
            if (!current) return original.call(this, filter, ...args);
            const previous = activeEffect, info = effectInfo(filter);
            const viewport = renderer.renderTarget?.viewport;
            const pixels = Math.max(0, Math.ceil(viewport?.width || 0)) *
              Math.max(0, Math.ceil(viewport?.height || 0));
            const output = this._filterGlobalUniforms?.uniforms?.uOutputFrame;
            const resolution = renderer.renderTarget?.renderTarget?.resolution || 1;
            const quadPixels = output && Number.isFinite(output[2]) && Number.isFinite(output[3])
              ? Math.min(pixels, Math.max(0, Math.ceil(output[2] * resolution)) *
                  Math.max(0, Math.ceil(output[3] * resolution)))
              : pixels;
            info.passes++;
            info.targetPixels += pixels;
            info.quadPixels += quadPixels;
            current.filterPasses++;
            current.filterTargetPixels += pixels;
            current.filterQuadPixels += quadPixels;
            activeEffect = info;
            const start = performance.now();
            try { return original.call(this, filter, ...args); }
            finally {
              info.submitMs += performance.now() - start;
              activeEffect = previous;
            }
          });
        hook(renderer.renderGroup, "_buildInstructions", original => function (group, ...args) {
          if (current) groupInfo(group).rebuilds++;
          return original.call(this, group, ...args);
        });
        hook(renderer.renderGroup, "_updateRenderGroups", original => function (group, ...args) {
          if (!current) return original.call(this, group, ...args);
          const parent = updatingGroup, info = groupInfo(group);
          const outer = depth++ === 0, start = performance.now();
          updatingGroup = info;
          try { return original.call(this, group, ...args); }
          finally {
            const elapsed = performance.now()-start;
            info.updateMs += elapsed;
            if (parent) parent.updateMs -= elapsed;
            updatingGroup = parent;
            depth--; if (outer) current.batchUpdateMs += elapsed;
          }
        });
        hook(renderer.renderPipes.batch, "upload", original => function (instructions) {
          if (current && updatingGroup) {
            for (const batch of Object.values(this._batchersByInstructionSet[instructions.uid] || {})) {
              batchOwners.set(batch, updatingGroup);
              if (batch.name === "flash-vectors" ||
                  (batch.name === "default" && Number.isFinite(batch.packedUpdates))) {
                const previous = updateCounts.get(batch) || [0, 0];
                const next = [batch.unchangedUpdates || 0, batch.packedUpdates || 0];
                for (const [i, key] of ["unchangedUpdates", "packedUpdates"].entries()) {
                  const count = next[i] - previous[i];
                  current[key] += count;
                  updatingGroup[key] += count;
                }
                updateCounts.set(batch, next);
                updatingGroup.vertexBytes = Math.max(updatingGroup.vertexBytes, batch.attributeSize * 4);
                if (batch.changedEnd > batch.changedStart)
                  updatingGroup.changedBytes += (batch.changedEnd-batch.changedStart)*4;
              }
            }
          }
          return original.call(this, instructions);
        });
        hook(renderer.renderPipes.batch, "execute", original => function (batch) {
          const parent = executingGroup;
          executingGroup = batchOwners.get(batch.batcher);
          try { return original.call(this, batch); }
          finally { executingGroup = parent; }
        });
        hook(renderer, "render", original => function (...args) {
          if (current || frames.length >= count) return original.apply(this, args);
          const frame = { preparedContents: stats.preparedContents || 0, retainedContents: stats.retainedContents || 0, syncMs: stats.syncMs, renderMs: 0, batchUpdateMs: 0, gpuMs: null,
            cpu: activeTick?.cpu || activeAdapter?.cpu || newCpu(),
            frameWorkMs: null, runtimeMs: null, adapterMs: null, frameIntervalMs: null,
            draws: 0, triangles: 0, uploadBytes: 0, blitPixels: 0,
            filterTargetPixels: 0, filterQuadPixels: 0, filterPasses: 0, unchangedUpdates: 0,
            packedUpdates: 0, sceneryCaches: stats.sceneryCaches || 0, batchGroups: stats.batchGroups || 0 };
          frames.push(frame); current = frame;
          if (activeTick) { activeTick.frames.push(frame); activeTick.draws++; }
          activeAdapter?.frames.push(frame);
          if (ext && !gl.getQuery(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) {
            frame.query = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, frame.query);
          }
          const start = performance.now();
          const end = enterSection?.("pixiRenderMs");
          try { return original.apply(this, args); }
          finally {
            end?.();
            frame.renderMs = performance.now()-start;
            if (frame.query) gl.endQuery(ext.TIME_ELAPSED_EXT);
            current = null;
          }
        });
        function check() {
          if (gl.isContextLost()) return finish("context lost");
          if (ext && gl.getParameter(ext.GPU_DISJOINT_EXT)) disjoint = true;
          for (const frame of frames) if (frame.query && gl.getQueryParameter(frame.query, gl.QUERY_RESULT_AVAILABLE)) {
            frame.gpuMs = gl.getQueryParameter(frame.query, gl.QUERY_RESULT) / 1e6;
            gl.deleteQuery(frame.query); delete frame.query;
          }
          if (frames.length >= count && frames.every(f => !f.query)) return finish("complete");
          if (performance.now()-started > 30000) return finish("timeout");
          poll = setTimeout(check, 100);
        }
        poll = setTimeout(check, 100);
      });
    },
  };
}
