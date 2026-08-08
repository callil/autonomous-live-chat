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

// Keep each active delivery item compact while retaining its linked issue and an
// accessible text status. The dot is decorative; working state is also conveyed
// by the adjacent status text.
function enhanceWorkItem(row) {
  const phase = row.querySelector('.work-item-phase');
  if (!phase || phase.dataset.activeIssueStatus === 'true') return;

  const terminal = phase.classList.contains('completed') || phase.classList.contains('rejected');
  row.dataset.terminal = terminal ? 'true' : 'false';
  if (terminal) return;

  const status = phase.textContent;
  const issue = [...row.querySelectorAll('.work-item-links a')].find(link => link.textContent.startsWith('Issue #'));
  const dot = document.createElement('i');
  dot.className = `active-status-dot${phase.classList.contains('needs_review') ? '' : ' working'}`;
  dot.setAttribute('aria-hidden', 'true');
  const statusText = document.createElement('span');
  statusText.textContent = status;
  phase.replaceChildren(dot, ...(issue ? [issue.cloneNode(true)] : []), statusText);
  phase.dataset.activeIssueStatus = 'true';

  const summary = row.querySelector('.work-item-summary')?.textContent;
  row.setAttribute('aria-label', `${issue?.textContent ? `${issue.textContent}, ` : ''}${status}${summary ? `: ${summary}` : ''}`);
}

function enhanceWorkItems(root) {
  if (root instanceof Element && root.matches('.work-item')) enhanceWorkItem(root);
  if (root instanceof Element || root instanceof Document) root.querySelectorAll('.work-item').forEach(enhanceWorkItem);
}

colorAvatars(document);
enhanceWorkItems(document);
new MutationObserver(records => {
  records.forEach(record => record.addedNodes.forEach(node => {
    colorAvatars(node);
    enhanceWorkItems(node);
  }));
}).observe(document, { childList: true, subtree: true });

const activeIssueStyles = document.createElement('style');
activeIssueStyles.textContent = `
  .work-item-phase[data-active-issue-status="true"] { display: inline-flex; align-items: center; gap: .375rem; }
  .work-item-phase[data-active-issue-status="true"] a { color: inherit; text-decoration-color: currentColor; text-underline-offset: .125rem; }
  .work-item-phase[data-active-issue-status="true"] .active-status-dot { flex: 0 0 auto; }
`;
document.head.append(activeIssueStyles);

const targetComposer = document.querySelector('#target-composer');
const targetRequestInput = document.querySelector('#target-request-input');
const targetRequestStatus = document.querySelector('#target-request-error');
targetComposer?.addEventListener('submit', () => {
  const submittedValue = targetRequestInput.value;
  const acknowledgement = new MutationObserver(() => {
    if (!targetRequestStatus.classList.contains('acknowledged')) return;
    if (targetRequestInput.value === submittedValue) {
      targetRequestInput.value = '';
      targetRequestInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    acknowledgement.disconnect();
  });
  acknowledgement.observe(targetRequestStatus, { attributes: true, childList: true });
});
