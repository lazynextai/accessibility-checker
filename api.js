// File: api.js
// Define the API endpoint for KPIs
const apiEndpoint = 'https://workers.dev/api/kpis';

// Function to get the KPIs
async function getKPIs() {
  try {
    const response = await fetch(apiEndpoint);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error getting KPIs:', error);
    throw error;
  }
}

export { getKPIs };