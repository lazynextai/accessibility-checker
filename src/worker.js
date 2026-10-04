// File: src/worker.js
import { scanMobileElements, integrateMobileScanning } from './mobileScanner.js';
import { HTMLParser } from './scanner.js';

addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  if (request.method === 'POST' && request.url.includes('/scan')) {
    const html = await request.text();
    const document = new DOMParser().parseFromString(html, 'text/html');
    const parser = new HTMLParser();
    const results = integrateMobileScanning(parser, document);
    return new Response(JSON.stringify(results), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response('Not Found', { status: 404 });
}