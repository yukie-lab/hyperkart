import * as THREE from 'three';

/**
 * Everything that dresses the circuit: vegetation, rocks, grandstands, crowds,
 * banners, signage, coastal props, canyon mesas, and the Rainbow Skyway's
 * celestial set pieces.
 *
 * Owned by the environment art system. `Race` constructs one of these and
 * calls `update()` each frame; nothing else in the codebase depends on its
 * internals, so it is free to build whatever it needs.
 *
 * Contract:
 *   new Scenery(track, scene, { envMap, quality, seed })
 *   .update(dt, time, cameraPos)
 *   .setEnvMap(envMap)
 *   .dispose()
 *
 * Placement should query `track` (spline, halfWidthAt, placeOnRoad,
 * frameAt, theme, waterLevel, minY/maxY) so props sit correctly on any
 * layout, and use instancing for anything appearing more than ~20 times.
 */
export class Scenery {
  constructor(track, scene, opts = {}) {
    this.track = track;
    this.scene = scene;
    this.theme = track.theme;
    this.envMap = opts.envMap || null;
    this.quality = opts.quality || 'high';
    this.seed = opts.seed ?? 1337;

    this.group = new THREE.Group();
    this.group.name = 'scenery';
    scene.add(this.group);

    this.materials = [];
    this.animated = [];
  }

  setEnvMap(envMap) {
    this.envMap = envMap;
    for (const m of this.materials) { m.envMap = envMap; m.needsUpdate = true; }
  }

  update(dt, time, cameraPos) {
    for (const fn of this.animated) fn(dt, time, cameraPos);
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh || o.isInstancedMesh) o.geometry?.dispose();
    });
    for (const m of this.materials) m.dispose();
    this.scene.remove(this.group);
  }
}
