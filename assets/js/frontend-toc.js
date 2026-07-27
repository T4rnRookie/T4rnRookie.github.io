(function () {
  const content = document.querySelector('.post-single .post-content');
  if (!content || document.querySelector('.frontend-toc')) return;

  const headings = Array.from(content.querySelectorAll('h1, h2, h3, h4, h5, h6'))
    .filter((heading) => getHeadingText(heading).length > 0);
  if (headings.length < 1) return;

  const slugCount = new Map();
  const links = new Map();

  function getHeadingText(heading) {
    const clone = heading.cloneNode(true);
    clone.querySelectorAll('.anchor, [aria-hidden="true"]').forEach((node) => node.remove());
    return clone.textContent.trim();
  }

  function slugify(text) {
    const base = text.trim()
      .toLowerCase()
      .replace(/[`~!@#$%^&*()+=[\]{}|;:'",.<>/?，。！？、；：“”‘’（）【】《》]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'heading';
    const count = slugCount.get(base) || 0;
    slugCount.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  }

  headings.forEach((heading) => {
    if (!heading.id) heading.id = slugify(getHeadingText(heading));
  });

  const toc = document.createElement('nav');
  toc.className = 'frontend-toc';
  toc.setAttribute('aria-label', '文章目录');
  toc.innerHTML = '<div class="frontend-toc__title">目录</div>';

  const rootList = document.createElement('ol');
  rootList.className = 'frontend-toc__list frontend-toc__list--root';
  toc.appendChild(rootList);

  // Build a real tree from h1~h6. The first heading can be any level,
  // and skipped levels are attached to the nearest existing parent.
  const stack = [{ level: 0, list: rootList }];

  headings.forEach((heading) => {
    const level = Number(heading.tagName.slice(1));
    const text = getHeadingText(heading);

    while (stack.length > 1 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }

    const item = document.createElement('li');
    item.className = `frontend-toc__item frontend-toc__item--level-${level}`;

    const link = document.createElement('a');
    link.className = `frontend-toc__link frontend-toc__link--level-${level}`;
    link.href = `#${encodeURIComponent(heading.id)}`;
    link.textContent = text;
    link.title = text;

    const childList = document.createElement('ol');
    childList.className = 'frontend-toc__list frontend-toc__list--child';

    item.appendChild(link);
    item.appendChild(childList);
    stack[stack.length - 1].list.appendChild(item);
    links.set(heading.id, link);

    stack.push({ level, list: childList });
  });

  document.body.appendChild(toc);

  function setActive(id) {
    links.forEach((link) => {
      link.classList.toggle('is-active', link.getAttribute('href') === `#${encodeURIComponent(id)}`);
    });
  }

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
