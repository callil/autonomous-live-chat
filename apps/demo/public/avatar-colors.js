function avatarColor(name) {
  let hash = 2166136261;
  for (const character of name.trim().normalize('NFKC').toLocaleLowerCase()) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `hsl(${(hash >>> 0) % 360} 70% 30%)`;
}

function colorAvatar(avatar) {
  const author = avatar.closest('.message')?.querySelector('.author');
  const name = author?.textContent;
  if (name) {
    const color = avatarColor(name);
    avatar.style.color = color;
    author.style.color = color;
  }
}

function colorAvatars(root) {
  if (root instanceof Element && root.matches('.message-avatar')) colorAvatar(root);
  if (root instanceof Element || root instanceof Document) root.querySelectorAll('.message-avatar').forEach(colorAvatar);
}

colorAvatars(document);
new MutationObserver(records => {
  records.forEach(record => record.addedNodes.forEach(node => colorAvatars(node)));
}).observe(document, { childList: true, subtree: true });
