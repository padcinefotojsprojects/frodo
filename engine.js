'use strict';

/*
 * Motor esférico 360° próprio.
 * Dependências externas: nenhuma. Renderização: WebGL 1.0 nativo.
 * Imagem padrão: ./panorama.jpg (equiretangular, proporção 2:1).
 * Opcional: window.TOUR_CONFIG antes de engine.js, com { image: 'caminho.jpg' }.
 */
(() => {
  const CONFIG = Object.assign({
    image: './imagem/frodo.jpg',
    sphereSegments: 96,
    sphereRings: 48,
    initialYaw: 0,
    initialPitch: 0,
    initialFov: 75,
    minFov: 35,
    maxFov: 100,
    dragSensitivity: 0.22,
    keyboardStep: 4,
    autoHideHintMs: 4200,
    maxPixelRatio: 2
  }, window.TOUR_CONFIG || {});

  const canvas = document.getElementById('tour-canvas');
  const loading = document.getElementById('loading');
  const errorBox = document.getElementById('error');
  const hint = document.getElementById('hint');
  const statusText = document.getElementById('status-text');
  const gyroButton = document.getElementById('gyro-button');
  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: true,
    depth: true,
    stencil: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false
  });

  if (!gl) {
    showError('Este navegador ou dispositivo não disponibiliza WebGL. Atualize o navegador ou teste outro dispositivo compatível.');
    return;
  }

  let program, vertexBuffer, indexBuffer, indexCount, texture;
  let yaw = CONFIG.initialYaw;
  let pitch = CONFIG.initialPitch;
  let fov = CONFIG.initialFov;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let pointerMoved = false;
  let gyroEnabled = false;
  let gyroBaseline = null;
  let gyroScreenAngle = 0;
  let hintTimer = null;
  let animationFrame = 0;
  let resizeObserver = null;
  const activePointers = new Map();
  let pinchStartDistance = 0;
  let pinchStartFov = fov;

  const vertexShaderSource = `
    attribute vec3 aPosition;
    attribute vec2 aUV;
    uniform mat4 uProjection;
    uniform mat4 uView;
    varying vec2 vUV;
    void main() {
      vUV = aUV;
      gl_Position = uProjection * uView * vec4(aPosition, 1.0);
    }
  `;

  const fragmentShaderSource = `
    precision mediump float;
    uniform sampler2D uPanorama;
    varying vec2 vUV;
    void main() {
      vec2 uv = vec2(fract(vUV.x), clamp(vUV.y, 0.001, 0.999));
      gl_FragColor = texture2D(uPanorama, uv);
    }
  `;

  function showError(message) {
    if (loading) loading.hidden = true;
    if (errorBox) {
      errorBox.textContent = message;
      errorBox.hidden = false;
    }
    if (statusText) statusText.textContent = 'Não foi possível iniciar';
  }

  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || 'Erro desconhecido no shader.';
      gl.deleteShader(shader);
      throw new Error('Falha ao compilar shader: ' + message);
    }
    return shader;
  }

  function createProgram() {
    const vertexShader = compileShader(gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource);
    const result = gl.createProgram();
    gl.attachShader(result, vertexShader);
    gl.attachShader(result, fragmentShader);
    gl.linkProgram(result);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(result, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(result) || 'Erro desconhecido ao ligar os shaders.';
      gl.deleteProgram(result);
      throw new Error('Falha ao criar programa WebGL: ' + message);
    }
    return result;
  }

  // Cria uma esfera UV. O observador fica no centro e vê a face interna.
  function createSphere(segments, rings) {
    const vertices = [];
    const indices = [];
    for (let y = 0; y <= rings; y++) {
      const v = y / rings;
      const latitude = v * Math.PI;
      for (let x = 0; x <= segments; x++) {
        const u = x / segments;
        // u=0.5 é o centro frontal da imagem; a câmera olha para -Z.
        const longitude = (u - 0.5) * Math.PI * 2;
        const sinLat = Math.sin(latitude);
        const px = Math.sin(longitude) * sinLat;
        const py = Math.cos(latitude);
        const pz = -Math.cos(longitude) * sinLat;
        vertices.push(px, py, pz, u, v);
      }
    }
    for (let y = 0; y < rings; y++) {
      for (let x = 0; x < segments; x++) {
        const a = y * (segments + 1) + x;
        const b = a + segments + 1;
        // Índices orientados para a face interna da esfera.
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
  }

  function perspective(fovDegrees, aspect, near, far) {
    const f = 1 / Math.tan((fovDegrees * Math.PI / 180) / 2);
    const nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0
    ]);
  }

  // Matriz de rotação da câmera. Sem translação: câmera no centro da esfera.
  function viewRotation(yawRadians, pitchRadians) {
    const cy = Math.cos(yawRadians), sy = Math.sin(yawRadians);
    const cp = Math.cos(pitchRadians), sp = Math.sin(pitchRadians);
    return new Float32Array([
      cy, sy * sp, -sy * cp, 0,
      0, cp, sp, 0,
      sy, -cy * sp, cy * cp, 0,
      0, 0, 0, 1
    ]);
  }

  function initGeometry() {
    const sphere = createSphere(CONFIG.sphereSegments, CONFIG.sphereRings);
    vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, sphere.vertices, gl.STATIC_DRAW);
    indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sphere.indices, gl.STATIC_DRAW);
    indexCount = sphere.indices.length;
  }

  function initTexture() {
    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // Textura provisória até a imagem ser carregada.
    const pixel = new Uint8Array([28, 32, 40, 255]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  function loadPanorama(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        if (!image.naturalWidth || !image.naturalHeight) {
          reject(new Error('O arquivo de panorama está vazio ou inválido.'));
          return;
        }
        const ratio = image.naturalWidth / image.naturalHeight;
        if (Math.abs(ratio - 2) > 0.025) {
          console.warn(`Panorama com proporção ${ratio.toFixed(3)}:1. O formato esperado é 2:1.`);
          statusText.textContent = 'Panorama carregado · proporção diferente de 2:1';
        }
        gl.bindTexture(gl.TEXTURE_2D, texture);
        // Com v=0 no topo da esfera, mantemos a orientação original da imagem.
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        // WebGL 1 exige CLAMP_TO_EDGE para texturas cujas dimensões não são potência de 2.
        const isPowerOfTwo = (value) => (value & (value - 1)) === 0;
        const canRepeatHorizontally = isPowerOfTwo(image.naturalWidth) && isPowerOfTwo(image.naturalHeight);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, canRepeatHorizontally ? gl.REPEAT : gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        resolve(image);
      };
      image.onerror = () => reject(new Error(`Não foi possível carregar "${url}". Confirme o nome do arquivo e sua localização.`));
      image.src = url;
    });
  }

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, CONFIG.maxPixelRatio);
    const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function render() {
    animationFrame = window.requestAnimationFrame(render);
    if (!program || !texture || !canvas.width || !canvas.height) return;
    gl.clearColor(0.055, 0.065, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);

    const positionLocation = gl.getAttribLocation(program, 'aPosition');
    const uvLocation = gl.getAttribLocation(program, 'aUV');
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(uvLocation);
    gl.vertexAttribPointer(uvLocation, 2, gl.FLOAT, false, 20, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);

    const aspect = canvas.width / canvas.height;
    const projection = perspective(fov, aspect, 0.1, 10);
    const view = viewRotation(yaw * Math.PI / 180, pitch * Math.PI / 180);
    gl.uniformMatrix4fv(gl.getUniformLocation(program, 'uProjection'), false, projection);
    gl.uniformMatrix4fv(gl.getUniformLocation(program, 'uView'), false, view);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(gl.getUniformLocation(program, 'uPanorama'), 0);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE); // Visível por dentro e evita depender da ordem das faces.
    gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
  }

  function hideHint() {
    hint.classList.add('is-hidden');
    if (hintTimer) window.clearTimeout(hintTimer);
  }
  function showHint(message) {
    hint.textContent = message;
    hint.classList.remove('is-hidden');
    if (hintTimer) window.clearTimeout(hintTimer);
    hintTimer = window.setTimeout(hideHint, CONFIG.autoHideHintMs);
  }
  function clampPitch(value) { return Math.max(-85, Math.min(85, value)); }
  function normalizeYaw(value) { return ((value + 180) % 360 + 360) % 360 - 180; }
  function changeView(dx, dy) {
    yaw = normalizeYaw(yaw + dx);
    pitch = clampPitch(pitch + dy);
  }
  function changeFov(delta) { fov = Math.max(CONFIG.minFov, Math.min(CONFIG.maxFov, fov + delta)); }

  canvas.addEventListener('pointerdown', (event) => {
    if (gyroEnabled) disableGyro(false);
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    canvas.setPointerCapture?.(event.pointerId);
    hideHint();
    if (activePointers.size === 1) {
      dragging = true;
      pointerMoved = false;
      lastX = event.clientX;
      lastY = event.clientY;
    } else if (activePointers.size === 2) {
      dragging = false;
      const points = Array.from(activePointers.values());
      pinchStartDistance = distance(points[0], points[1]);
      pinchStartFov = fov;
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!activePointers.has(event.pointerId)) return;
    const previous = activePointers.get(event.pointerId);
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointers.size >= 2) {
      const points = Array.from(activePointers.values());
      const currentDistance = distance(points[0], points[1]);
      if (pinchStartDistance > 0) {
        fov = Math.max(CONFIG.minFov, Math.min(CONFIG.maxFov, pinchStartFov - (currentDistance - pinchStartDistance) * 0.12));
      }
      return;
    }
    if (!dragging) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 1) pointerMoved = true;
    changeView(-dx * CONFIG.dragSensitivity, -dy * CONFIG.dragSensitivity);
    lastX = event.clientX;
    lastY = event.clientY;
  });

  function endPointer(event) {
    activePointers.delete(event.pointerId);
    if (activePointers.size === 0) {
      dragging = false;
      pinchStartDistance = 0;
    } else if (activePointers.size === 1) {
      const remaining = Array.from(activePointers.values())[0];
      lastX = remaining.x;
      lastY = remaining.y;
      dragging = true;
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('lostpointercapture', endPointer);
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    changeFov(event.deltaY > 0 ? 3 : -3);
    hideHint();
  }, { passive: false });
  canvas.addEventListener('dblclick', () => { fov = CONFIG.initialFov; });

  function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function bindButton(id, action) {
    const button = document.getElementById(id);
    button.addEventListener('click', () => { action(); hideHint(); });
  }
  bindButton('left-button', () => changeView(-CONFIG.keyboardStep, 0));
  bindButton('right-button', () => changeView(CONFIG.keyboardStep, 0));
  bindButton('up-button', () => changeView(0, CONFIG.keyboardStep));
  bindButton('down-button', () => changeView(0, -CONFIG.keyboardStep));
  bindButton('zoom-in-button', () => changeFov(-5));
  bindButton('zoom-out-button', () => changeFov(5));
  bindButton('reset-button', () => { yaw = CONFIG.initialYaw; pitch = CONFIG.initialPitch; fov = CONFIG.initialFov; gyroBaseline = null; });

  document.addEventListener('keydown', (event) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    let handled = true;
    switch (event.key) {
      case 'ArrowLeft': changeView(-CONFIG.keyboardStep, 0); break;
      case 'ArrowRight': changeView(CONFIG.keyboardStep, 0); break;
      case 'ArrowUp': changeView(0, CONFIG.keyboardStep); break;
      case 'ArrowDown': changeView(0, -CONFIG.keyboardStep); break;
      case '+': case '=': changeFov(-5); break;
      case '-': changeFov(5); break;
      case 'Home': yaw = CONFIG.initialYaw; pitch = CONFIG.initialPitch; fov = CONFIG.initialFov; break;
      default: handled = false;
    }
    if (handled) { event.preventDefault(); hideHint(); }
  });

  document.getElementById('fullscreen-button').addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) await document.querySelector('.tour').requestFullscreen();
      else await document.exitFullscreen();
    } catch (err) {
      showHint('Tela cheia não está disponível neste navegador.');
    }
  });

  function onOrientation(event) {
    if (!gyroEnabled || event.alpha == null || event.beta == null || event.gamma == null) return;
    const screenAngle = (screen.orientation && typeof screen.orientation.angle === 'number')
      ? screen.orientation.angle
      : (typeof window.orientation === 'number' ? window.orientation : 0);
    if (screenAngle !== gyroScreenAngle) {
      gyroScreenAngle = screenAngle;
      gyroBaseline = null;
    }
    // Usa o eixo alpha como direção horizontal e beta como inclinação.
    const alpha = event.alpha;
    const beta = event.beta;
    if (!gyroBaseline) {
      gyroBaseline = { alpha, beta, gamma: event.gamma, screenAngle };
      showHint('Sensor ativo · mova o dispositivo para explorar');
      return;
    }
    let deltaYaw = alpha - gyroBaseline.alpha;
    if (deltaYaw > 180) deltaYaw -= 360;
    if (deltaYaw < -180) deltaYaw += 360;
    let deltaPitch = beta - gyroBaseline.beta;
    if (screenAngle === 90) { deltaPitch = event.gamma - gyroBaseline.gamma; }
    if (screenAngle === -90 || screenAngle === 270) { deltaPitch = -(event.gamma - gyroBaseline.gamma); }
    yaw = normalizeYaw(CONFIG.initialYaw - deltaYaw);
    pitch = clampPitch(CONFIG.initialPitch - deltaPitch);
  }

  async function enableGyro() {
    if (!('DeviceOrientationEvent' in window)) {
      showHint('Este dispositivo não oferece sensor de orientação.');
      return;
    }
    try {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        const permission = await DeviceOrientationEvent.requestPermission();
        if (permission !== 'granted') throw new Error('Permissão do sensor negada.');
      }
      window.addEventListener('deviceorientation', onOrientation, true);
      gyroEnabled = true;
      gyroBaseline = null;
      gyroButton.setAttribute('aria-pressed', 'true');
      gyroButton.title = 'Desativar giroscópio';
      statusText.textContent = 'Sensor de orientação ativado';
      showHint('Sensor ativo · mova o dispositivo para explorar');
    } catch (err) {
      showHint(err.message || 'Não foi possível ativar o sensor. Verifique as permissões.');
    }
  }

  function disableGyro(showMessage = true) {
    window.removeEventListener('deviceorientation', onOrientation, true);
    gyroEnabled = false;
    gyroBaseline = null;
    gyroButton.setAttribute('aria-pressed', 'false');
    gyroButton.title = 'Ativar giroscópio';
    if (statusText) statusText.textContent = 'Panorama interativo';
    if (showMessage) showHint('Sensor desativado');
  }
  gyroButton.addEventListener('click', () => gyroEnabled ? disableGyro() : enableGyro());
  window.addEventListener('orientationchange', () => { gyroBaseline = null; });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && animationFrame) {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    } else if (!document.hidden && !animationFrame) {
      render();
    }
  });

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    if (animationFrame) window.cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    showError('A sessão gráfica WebGL foi interrompida pelo navegador. Recarregue a página para restaurar o tour.');
  }, false);

  async function start() {
    try {
      program = createProgram();
      initGeometry();
      initTexture();
      resize();
      if ('ResizeObserver' in window) {
        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(canvas);
      } else {
        window.addEventListener('resize', resize, { passive: true });
      }
      await loadPanorama(CONFIG.image);
      loading.hidden = true;
      errorBox.hidden = true;
      statusText.textContent = 'Panorama interativo';
      showHint('Arraste para olhar ao redor');
      render();
    } catch (err) {
      console.error(err);
      showError(err.message || 'Ocorreu um erro ao iniciar o tour.');
    }
  }

  start();
})();