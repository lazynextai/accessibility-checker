// File: script.js
// Import the necessary APIs
import { getKPIs } from './api.js';

// Function to update the KPIs
async function updateKPIs() {
  try {
    const response = await getKPIs();
    const userAcquisition = response.userAcquisition;
    const revenueGrowth = response.revenueGrowth;

    // Update the UI with the KPIs
    document.getElementById('user-acquisition').innerText = `Users: ${userAcquisition}`;
    document.getElementById('revenue-growth').innerText = `Revenue: ${revenueGrowth}%`;
  } catch (error) {
    console.error('Error updating KPIs:', error);
  }
}

// Update the KPIs on page load
updateKPIs();

// Update the KPIs every 60 seconds
setInterval(updateKPIs, 60000);