(function () {
  const content = document.querySelector('.post-single .post-content');
  if (!content || document.querySelector('.frontend-toc')) return;

  const headings = Array.from(content.querySelectorAll('h1, h2, h3, h4, h5, h6'))
    .filter((heading) => heading.textContent.trim().length > 0);
  if (headings.length < 2) return;

  const slugCount = new Map();
  const slugify = (text) => {
    const base = text.trim()
      .toLowerCase()
      .replace(/[`~!@#$%^&*()+=[\]{}|;:'",.<>/?，。！？、；：“”‘’（）【】《》]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'heading';
    const count = slugCount.get(base) || 0;
    slugCount.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  };

  headings.forEach((heading) => {
    if (!heading.id) heading.id = slugify(heading.textContent);
  });

  const toc = document.createElement('nav');
  toc.className = 'frontend-toc';
  toc.setAttribute('aria-label', '文章目录');
  toc.innerHTML = '<div class="frontend-toc__title">目录</div><ol class="frontend-toc__list"></ol>';

  const list = toc.querySelector('.frontend-toc__list');
  const links = new Map();

  headings.forEach((heading) => {
    const level = Number(heading.tagName.slice(1));
    const text = heading.textContent.replace(/#/g, '').trim();
    const item = document.createElement('li');
    item.className = 'frontend-toc__item';

    const link = document.createElement('a');
    link.className = `frontend-toc__link frontend-toc__level-${level}`;
    link.href = `#${encodeURIComponent(heading.id)}`;
    link.textContent = text;
    link.title = text;

    item.appendChild(link);
    list.appendChild(item);
    links.set(heading.id, link);
  });

  document.body.appendChild(toc);

  const setActive = (id) => {
    links.forEach((link) => {
      link.classList.toggle('is-active', link.getAttribute('href') === `#${encodeURIComponent(id)}`);
    });
  };

  if ('IntersectionObserver' in window) {
    const visible = new Map();
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top);
        else visible.delete(entry.target.id);
      });
      if (visible.size) {
        const activeId = Array.from(visible.entries()).sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]))[0][0];
        setActive(activeId);
      }
    }, { rootMargin: '-15% 0px -70% 0px', threshold: [0, 1] });
    headings.forEach((heading) => observer.observe(heading));
  } else {
    const onScroll = () => {
      let active = headings[0];
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top <= 120) active = heading;
        else break;
      }
      setActive(active.id);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
})();
