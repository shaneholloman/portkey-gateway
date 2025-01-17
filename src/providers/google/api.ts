import { ProviderAPIConfig } from '../types';

export const GoogleApiConfig: ProviderAPIConfig = {
  getBaseURL: () => 'https://generativelanguage.googleapis.com/v1beta',
  headers: () => {
    return { 'Content-Type': 'application/json' };
  },
  getEndpoint: ({ fn, providerOptions, gatewayRequestBodyJSON }) => {
    let mappedFn = fn;
    const { model, stream } = gatewayRequestBodyJSON;
    const { apiKey } = providerOptions;
    if (stream && fn === 'chatComplete') {
      return `/models/${model}:streamGenerateContent?key=${apiKey}`;
    }
    switch (mappedFn) {
      case 'chatComplete': {
        return `/models/${model}:generateContent?key=${apiKey}`;
      }
      case 'embed': {
        return `/models/${model}:embedContent?key=${apiKey}`;
      }
      default:
        return '';
    }
  },
};

export default GoogleApiConfig;
