import * as THREE from 'three';
import { skyPresetFor, linColor } from './SkyPresets.js';
import { clamp01 } from '../core/MathX.js';

/**
 * Scene lighting.
 *
 * Rather than cascaded shadow maps over the whole circuit, this uses a single
 * high-resolution shadow map tightly fitted to a box that follows the player.
 * A kart camera never strays far from the action, so fine texels over a small
 * box beat three coarse cascades stretched across 600 m — sharper contact
 * shadows, one shadow pass, and no per-material patching.
 *
 * At SHADOW_EXTENT 62 the box is 124 m across, which on the 2048 map used at
 * `high` is 6.1 cm per texel. (This comment previously claimed 3 cm over a
 * 130 m box while the extent was 78 — a 156 m box at 7.6 cm. Do the arithmetic
 * again if you change either number; the figure is load-bearing for judging
 * whether contact shadows can read at all.)
 */

const SHADOW_EXTENT = 62;      // half-size of the fitted shadow box, metres
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
    // Halved. `normalBias` pushes the shadow lookup along the surface normal,
    // and under a 16-degree sun that push translates into a large *lateral*
    // shift of where the shadow lands — enough to leave a strip of lit road
    // between a front wheel and its own shadow. It was set high to fight acne
    // on a road that was almost black; with the ambient starvation fixed the
    // road no longer needs it.
    this.sun.shadow.normalBias = 0.014;
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

    // Light thrown back up by an emissive road.
    //
    // A hemisphere light's ground half only reaches surfaces whose normals
    // point down, and almost nothing on a kart does — driving its `groundColor`
    // from the road moved the underside by 4%. A road at emissiveIntensity 1.35
    // directly beneath the kart is a large area source, and the honest cheap
    // stand-in for one is a light aimed straight up. Off on circuits whose road
    // does not emit.
    this.bounce = new THREE.DirectionalLight(0xffffff, 0);
    this.bounceTarget = new THREE.Object3D();
    this.bounce.target = this.bounceTarget;
    scene.add(this.bounce, this.bounceTarget);

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
    // The colour of the light coming back *up* off the world, which is not
    // always the colour of the ground's albedo. On a night street circuit the
    // ground is grey concrete and the light bouncing off it is sodium, so the
    // two have to be separable; everywhere else they are the same thing and
    // this falls through to the ground's own colour.
    this.hemi.groundColor.setHex(theme.bounceColor ?? theme.groundColor);
    // On a road that emits its own light, the theme's `groundColor` is a lie.
    // Rainbow Skyway declares 0x0a0620 — near-black — while running a road at
    // emissiveIntensity 1.35, so the brightest surface in the game bounced
    // nothing. Karts measured a mean luma of 45.2 there against 126.4 on the
    // coast, with the underside at 28.6 under a top half of 57.8: darkest on
    // the brightest circuit. `update` drives the bounce from the hue actually
    // beneath the kart instead.
    this._roadBounce = theme.roadSurface === 'rainbow';
    this.bounce.intensity = this._roadBounce ? (sunIntensity ?? 1) * 0.55 : 0;
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
    // How much of the key comes back as a broad opposite-side fill. A dark sky
    // delivers almost no ambient through the probe, so a theme that meters no
    // sky has to buy that separation back here — which is a property of the
    // atmosphere, and so a number the theme states rather than a track name
    // this line has to recognise.
    this.fill.intensity = (sunIntensity ?? 1) * (theme.fill ?? 0.045);
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
  update(dt, focusPos, forwardDir, ground) {
    this._focus.copy(focusPos);
    if (forwardDir) this._focus.addScaledVector(forwardDir, SHADOW_FORWARD);

    // Light coming back up off an emissive road.
    //
    // One hemisphere light cannot give each kart its own bounce, so it takes
    // the colour under the *player*, who owns the middle of the frame and whose
    // rivals are usually within a stripe or two. The road's ramp is seven
    // bands of `setHSL(hue, 0.92, 0.56)` across its width; this follows the
    // same mapping continuously, because a bounce integrates over an area and
    // has no business stepping at a stripe edge the way the texture does.
    if (this._roadBounce && ground && ground.halfWidth > 0) {
      const u = clamp01((ground.lateral + ground.halfWidth) / (2 * ground.halfWidth));
      this.hemi.groundColor.setHSL((u + 0.02) % 1, 0.62, 0.42);
      this.bounce.color.setHSL((u + 0.02) % 1, 0.55, 0.60);
      // Straight up, from just under the road, at the kart.
      this.bounceTarget.position.copy(focusPos);
      this.bounce.position.set(focusPos.x, focusPos.y - 30, focusPos.z);
      this.bounceTarget.updateMatrixWorld();
      this.bounce.updateMatrixWorld();
    }

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
    this.scene.remove(this.sun, this.hemi, this.fill, this.sunTarget, this.bounce, this.bounceTarget);
    this.sun.dispose?.();
  }
}
