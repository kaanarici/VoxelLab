export const VOLUME_RAYCAST_VERTEX_SHADER =           `
      varying vec3 vOrigin;
      varying vec3 vDir;
      void main() {

        vec3 viewDirObj = normalize((inverse(modelViewMatrix) * vec4(0.0, 0.0, -1.0, 0.0)).xyz);
        vDir = viewDirObj;
        vOrigin = position - viewDirObj * 4.0 + vec3(0.5);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;

export const VOLUME_RAYCAST_FRAGMENT_SHADER =           `
      precision highp float;
      precision highp sampler3D;
      uniform sampler3D uVolume;
      uniform sampler3D uLabel;
      uniform int       uLabelMode;
      uniform sampler2D uLabelLUT;
      uniform float     uLabelAlpha;
      uniform float uSteps;
      uniform float uLowT;
      uniform float uHighT;
      uniform float uIntensity;
      uniform vec3  uClipMin;
      uniform vec3  uClipMax;
      uniform vec4  uClipPlane;
      uniform int   uClipPlaneEnabled;
      uniform int   uMode;
      uniform vec3  uVolSize;
      uniform int   uIsolate;
      varying vec3 vOrigin;
      varying vec3 vDir;

      vec2 hitBox(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
        vec3 invR = 1.0 / rd;
        vec3 tMin = (bmin - ro) * invR;
        vec3 tMax = (bmax - ro) * invR;
        vec3 t1 = min(tMin, tMax);
        vec3 t2 = max(tMin, tMax);
        return vec2(max(max(t1.x, t1.y), t1.z), min(min(t2.x, t2.y), t2.z));
      }

      vec4 labelLUT(int idx) {
        if (idx <= 0 || idx > 255) return vec4(0.0, 0.0, 0.0, 1.0);
        float u = (float(idx) + 0.5) / 256.0;
        return texture(uLabelLUT, vec2(u, 0.5));
      }

      bool clippedByObliquePlane(vec3 p) {
        return uClipPlaneEnabled == 1 && dot(uClipPlane.xyz, p) + uClipPlane.w < 0.0;
      }

      bool labelVisible(int label) {
        return uLabelMode == 0 || (labelLUT(label).a >= 0.004 && (uIsolate == 0 || label > 0));
      }

      vec3 labelColor(float intensity, int label) {
        vec3 color = vec3(intensity);
        if (uLabelMode > 0 && label > 0) {
          vec3 tint = labelLUT(label).rgb;
          if (tint.r + tint.g + tint.b > 0.001) color = mix(color, tint, uLabelAlpha);
        }
        return color;
      }

      void main() {
        vec3 rd = normalize(vDir);
        vec2 t = hitBox(vOrigin, rd, uClipMin, uClipMax);
        if (t.x >= t.y) discard;
        t.x = max(t.x, 0.0);

        float dt = (t.y - t.x) / uSteps;
        float voxelStep = length(rd * dt * uVolSize);
        vec3 p = vOrigin + (t.x + 0.5 * dt) * rd;

        if (uMode == 0) {
          vec4 acc = vec4(0.0);
          for (float i = 0.0; i < 2048.0; i++) {
            if (i >= uSteps) break;
            if (clippedByObliquePlane(p)) { p += rd * dt; continue; }
            float raw = texture(uVolume, p).r;

            if (raw < 0.003) { p += rd * dt; continue; }

            if (raw >= uLowT && raw <= uHighT) {
              float s = (raw - uLowT) / max(1e-4, uHighT - uLowT);
              float a = 1.0 - exp(-s * uIntensity * voxelStep * 1.5);

              vec3 base = vec3(s);
              if (uLabelMode > 0) {
                int lbl = int(texture(uLabel, p).r * 255.0 + 0.5);
                vec4 lut = labelLUT(lbl);

                if (!labelVisible(lbl)) { p += rd * dt; continue; }
                if (lut.r + lut.g + lut.b > 0.001) {
                  base = mix(vec3(s), lut.rgb, uLabelAlpha);
                }
                a *= lut.a;
              }

              acc.rgb += (1.0 - acc.a) * a * base;
              acc.a   += (1.0 - acc.a) * a;
              if (acc.a >= 0.985) break;
            }
            p += rd * dt;
          }
          if (acc.a < 0.01) discard;
          gl_FragColor = vec4(acc.rgb, acc.a);
        } else if (uMode == 1) {

          float maxV = 0.0;
          int maxLbl = 0;
          for (float i = 0.0; i < 2048.0; i++) {
            if (i >= uSteps) break;
            if (clippedByObliquePlane(p)) { p += rd * dt; continue; }
            float raw = texture(uVolume, p).r;
            int label = uLabelMode > 0 ? int(texture(uLabel, p).r * 255.0 + 0.5) : 0;
            if (!labelVisible(label)) { p += rd * dt; continue; }
            if (raw >= uLowT && raw <= uHighT && raw > maxV) {
              maxV = raw;
              maxLbl = label;
            }
            p += rd * dt;
          }
          if (maxV <= uLowT + 0.001) discard;
          float s = (maxV - uLowT) / max(1e-4, uHighT - uLowT);
          s = clamp(s, 0.0, 1.0);
          gl_FragColor = vec4(labelColor(s, maxLbl), 1.0);
        } else {

          float minV = 1.0;
          int minLbl = 0;
          bool any = false;
          for (float i = 0.0; i < 2048.0; i++) {
            if (i >= uSteps) break;
            if (clippedByObliquePlane(p)) { p += rd * dt; continue; }
            float raw = texture(uVolume, p).r;
            int label = uLabelMode > 0 ? int(texture(uLabel, p).r * 255.0 + 0.5) : 0;
            if (!labelVisible(label)) { p += rd * dt; continue; }
            if (raw >= uLowT && raw <= uHighT) {
              if (!any || raw < minV) {
                minV = raw;
                minLbl = label;
              }
              any = true;
            }
            p += rd * dt;
          }
          if (!any) discard;
          float s = 1.0 - (minV - uLowT) / max(1e-4, uHighT - uLowT);
          s = clamp(s, 0.0, 1.0);
          gl_FragColor = vec4(labelColor(s, minLbl), 1.0);
        }
      }
    `;
