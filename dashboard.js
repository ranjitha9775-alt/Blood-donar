async function loadDashboard() {
  const welcome = document.getElementById('welcome');
  const logoutButton = document.getElementById('logout-button');

  try {
    const response = await fetch('/api/me', {
      credentials: 'same-origin'
    });

    if (!response.ok) {
      window.location.replace('/login');
      return;
    }

    const result = await response.json();
    const user = result.user;
    const path = window.location.pathname;

    const expectedRole = path.includes('patient-dashboard')
      ? 'patient'
      : 'donor';

    if (user.role !== expectedRole) {
      window.location.replace(
        user.role === 'donor'
          ? '/donar-dashboard.html'
          : '/patient-dashboard.html'
      );
      return;
    }

    welcome.textContent = `Welcome, ${user.full_name}!`;
    logoutButton.hidden = false;
  } catch (error) {
    welcome.textContent = 'Could not verify your login. Please try again.';
  }
}

document.getElementById('logout-button').addEventListener(
  'click',
  async () => {
    try {
      const response = await fetch('/api/logout', {
        method: 'POST',
        credentials: 'same-origin'
      });

      if (response.ok) {
        window.location.replace('/login');
      } else {
        alert('Logout failed. Please try again.');
      }
    } catch {
      alert('Could not connect to the server.');
    }
  }
);

loadDashboard();