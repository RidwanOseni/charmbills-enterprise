import axios from 'axios';

// In development: use localhost
// In production: use environment variable or relative path with proxy
const API_BASE_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3002';

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add request interceptor for logging
api.interceptors.request.use((config) => {
  console.log(`[API] ${config.method?.toUpperCase()} ${config.baseURL}${config.url}`);
  return config;
});

// Add response interceptor for error handling
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 404) {
      console.error(`[API] 404: ${error.config?.url} - Backend route not found`);
    } else if (error.code === 'ECONNREFUSED') {
      console.error('[API] Backend not running. Start with: npm run dev');
    }
    return Promise.reject(error);
  }
);

export default api;