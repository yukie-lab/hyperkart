import * as THREE from 'three';
import { skyPresetFor, linColor } from './SkyPresets.js';

/**
 * Scene lighting.
 *
 * Rather than cascaded shadow maps over the whole circuit, this uses a single
 * high-resolution shadow map tightly fitted to a box that follows the player.
 * A kart camera never strays far from the action, so ~3 cm shadow texels over
 * a 130 m box beats three coarse cascades stretched across 600 m — sharper
 * contact shadows, one shadow pass, and no per-material patching.
 */

const SHADOW_EXTENT = 78;      // half-size of the fitted shadow box, metres
const SHADOW_FORWARD = 34;     // bias the box ahead of the player

export class Lighting {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.quality = opts.quality || 'high';

    const mapSize = this.quality === 'ultra' ? 4096 : this.quality === 'high' ? 2048 : 1024;

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(mapSize, mapSize);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 460;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.028;
    // No `radius`/`blurSamples` here: both are ignored by PCFShadowMap, which
    // is what the renderer uses (see Renderer.js for why VSM was rejected).
    // Leaving them set would read as soft shadows being configured when they
    // are not, which is how they came to be assumed working in the first place.
    const cam = this.sun.shadow.camera;
    cam.left = -SHADOW_EXTENT; cam.right = SHADOW_EXTENT;
    cam.top = SHADOW_EXTENT; cam.bottom = -SHADOW_EXTENT;
    cam.updateProjectionMatrix();

    this.sunTarget = new THREE.Object3D();
    scene.add(this.sunTarget);
    this.sun.target = this.sunTarget;
    scene.add(this.sun);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.4);
    scene.add(this.hemi);

    // A dim, cool fill from the opposite side keeps shadowed bodywork from
    // going flat black — the job a bounce card does on a real shoot.
    this.fill = new THREE.DirectionalLight(0xffffff, 0.35);
    scene.add(this.fill);

    this.sunDirection = new THREE.Vector3(0, 1, 0);
    this._focus = new THREE.Vector3();
    this._snap = new THREE.Vector3();
  }

  applyTheme(theme, sunDirection, sunIntensity) {
    this.theme = theme;
    const preset = skyPresetFor(theme);
    this.sunDirection.copy(sunDirection);

    this.sun.color.setHex(theme.sunColor);
    this.sun.intensity = sunIntensity ?? (theme.sunStrength ?? 3.0);

    this.hemi.color.setHex(theme.ambientColor);
    this.hemi.groundColor.setHex(theme.groundColor);
    // This is the *ground bounce*, and it is not a rounding error.
    //
    // The environment probe is generated from the sky dome alone, so it
    // contains no light coming back up off the world. At sunsetCoast's
    // 16-degree sun that omission dominates: the sun puts almost nothing on a
    // flat road, the probe supplies only downward sky light, and the tarmac
    // measured a median of 26/255 for the half of the lap that faces away from
    // the sun while measuring 143/255 on the half that faces it. A four-fold
    // swing in the readability of the driving surface, from a term that was
    // set to 0.10 and described as a rounding detail.
    //
    // `groundColor` is the theme's own sand/dirt, so this warms shadowed
    // surfaces from below the way a bright sunlit landscape actually does.
    this.hemi.intensity = (theme.ambientIntensity ?? 0.2) * (sunIntensity ?? 1) * 0.38;

    this.fill.color.setHex(theme.ambientColor);
    this.fill.intensity = (sunIntensity ?? 1) * (theme.key === 'rainbow' ? 0.10 : 0.045);
    this.fill.position.copy(sunDirection).multiplyScalar(-160);
    this.fill.position.y = Math.abs(this.fill.position.y) * 0.6 + 60;

    // Fog comes from the same preset as the dome, in the same scene-linear
    // units. Matching the horizon colour is the whole point: distant geometry
    // has to dissolve into the sky it is standing against, not into a
    // separately-authored grey that reads as a wall of haze.
    if (preset.fogDensity > 0) {
      this.scene.fog = new THREE.FogExp2(0x000000, preset.fogDensity);
      this.scene.fog.color.copy(linColor(preset.fogColor));
    } else {
      this.scene.fog = null;
    }
  }

  /**
   * Re-centre the shadow box on the action.
   * The focus point is snapped to shadow-texel increments; without that, the
   * shadow edges crawl and shimmer as the camera moves.
   */
  update(dt, focusPos, forwardDir) {
    this._focus.copy(focusPos);
    if (forwardDir) this._focus.addScaledVector(forwardDir, SHADOW_FORWARD);

    const texelWorld = (SHADOW_EXTENT * 2) / this.sun.shadow.mapSize.x;
    this._snap.set(
      Math.round(this._focus.x / texelWorld) * texelWorld,
      Math.round(this._focus.y / texelWorld) * texelWorld,
      Math.round(this._focus.z / texelWorld) * texelWorld,
    );

    this.sunTarget.position.copy(this._snap);
    this.sun.position.copy(this._snap).addScaledVector(this.sunDirection, 230);
    this.sunTarget.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }

  setQuality(q) {
    const mapSize = q === 'ultra' ? 4096 : q === 'high' ? 2048 : 1024;
    if (this.sun.shadow.mapSize.x === mapSize) return;
    this.sun.shadow.mapSize.set(mapSize, mapSize);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    this.quality = q;
  }

  dispose() {
    this.scene.remove(this.sun, this.hemi, this.fill, this.sunTarget);
    this.sun.dispose?.();
  }
}
