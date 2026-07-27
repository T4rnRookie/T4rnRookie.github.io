(function () {
  const decoder = new TextDecoder();

  function fromBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function deriveKey(password, salt, iterations) {
    const material = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
  }

  async function decryptPost(payload, password) {
    const key = await deriveKey(password, fromBase64(payload.salt), payload.iterations);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(payload.iv) },
      key,
      fromBase64(payload.ciphertext)
    );
    return decoder.decode(plain);
  }

  function initProtectedPost(box) {
    const payloadEl = box.querySelector('script[type="application/json"]');
    const form = box.querySelector('.protected-post__form');
    const input = box.querySelector('.protected-post__input');
    const message = box.querySelector('.protected-post__message');
    const content = box.closest('.post-content');
    if (!payloadEl || !form || !input || !content) return;

    const payload = JSON.parse(payloadEl.textContent);
    const password = box.dataset.password || '';
    if (password) input.value = password;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      message.textContent = '解密中...';
      try {
        const html = await decryptPost(payload, input.value);
        content.innerHTML = html;
        if (window.buildFrontendToc) window.buildFrontendToc();
      } catch (error) {
        message.textContent = '密码不对，或者密文损坏。';
      }
    });
  }

  if (!window.crypto || !window.crypto.subtle) {
    document.querySelectorAll('.protected-post__message').forEach((el) => {
      el.textContent = '当前浏览器不支持 WebCrypto，无法解密。';
    });
    return;
  }

  document.querySelectorAll('.protected-post').forEach(initProtectedPost);
})();
