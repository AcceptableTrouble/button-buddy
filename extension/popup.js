const goalInput = document.getElementById('goal');
const findBtn = document.getElementById('find');
const msg = document.getElementById('msg');

async function sendGoalToActiveTab(goal) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    msg.textContent = 'No active tab.';
    return;
  }
  await chrome.tabs.sendMessage(tab.id, { type: 'BB_FIND', goal });
}

findBtn.addEventListener('click', async () => {
  const goal = (goalInput.value || '').trim();
  if (!goal) {
    msg.textContent = 'Enter a goal.';
    return;
  }
  msg.textContent = 'Finding…';
  try {
    await sendGoalToActiveTab(goal);
    msg.textContent = '';
  } catch (e) {
    msg.textContent = 'Could not reach this page. Try reloading it.';
  }
});

goalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') findBtn.click();
}); 