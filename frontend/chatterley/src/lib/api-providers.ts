/**
 * API Provider configurations and utilities
 */

import { ApiProvider } from './types';

export const API_PROVIDERS: Record<string, ApiProvider> = {
  openai: {
    id: 'openai',
    name: 'openai',
    displayName: 'OpenAI',
    description: 'GPT-4, GPT-3.5, and other OpenAI models',
    website: 'https://platform.openai.com',
    keyName: 'OPENAI_API_KEY',
    keyPlaceholder: 'sk-...',
    baseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
    testEndpoint: '/models',
    pricing: {
      currency: 'USD',
      unit: '1M tokens',
    },
    models: [
      {
        id: 'gpt-4o',
        name: 'gpt-4o',
        displayName: 'GPT-4o',
        description: 'Most capable GPT-4 model, great for complex tasks',
        contextLength: 128000,
        inputCost: 5.00,
        outputCost: 15.00,
        isMultimodal: true,
        isVisionCapable: true,
        isOmniCapable: true,
        tags: ['reasoning', 'multimodal', 'latest'],
      },
      {
        id: 'gpt-4o-mini',
        name: 'gpt-4o-mini',
        displayName: 'GPT-4o Mini',
        description: 'Smaller, faster, and cheaper GPT-4 variant',
        contextLength: 128000,
        inputCost: 0.15,
        outputCost: 0.60,
        isMultimodal: true,
        isVisionCapable: true,
        isOmniCapable: false,
        tags: ['fast', 'affordable', 'multimodal'],
      },
      {
        id: 'gpt-4-turbo',
        name: 'gpt-4-turbo',
        displayName: 'GPT-4 Turbo',
        description: 'High-performance GPT-4 with large context window',
        contextLength: 128000,
        inputCost: 10.00,
        outputCost: 30.00,
        isMultimodal: true,
        isVisionCapable: true,
        isOmniCapable: false,
        tags: ['reasoning', 'multimodal'],
      },
      {
        id: 'gpt-3.5-turbo',
        name: 'gpt-3.5-turbo',
        displayName: 'GPT-3.5 Turbo',
        description: 'Fast and efficient for most tasks',
        contextLength: 16385,
        inputCost: 0.50,
        outputCost: 1.50,
        tags: ['fast', 'affordable'],
      },
    ],
  },
  anthropic: {
    id: 'anthropic',
    name: 'anthropic',
    displayName: 'Anthropic',
    description: 'Claude models with strong reasoning capabilities',
    website: 'https://console.anthropic.com',
    keyName: 'ANTHROPIC_API_KEY',
    keyPlaceholder: 'sk-ant-...',
    baseUrl: 'https://api.anthropic.com/v1',
    requiresKey: true,
    testEndpoint: '/messages',
    pricing: {
      currency: 'USD',
      unit: '1M tokens',
    },
    models: [
      {
        id: 'claude-3-5-sonnet-20241022',
        name: 'claude-3-5-sonnet-20241022',
        displayName: 'Claude 3.5 Sonnet',
        description: 'Most capable Claude model with excellent reasoning',
        contextLength: 200000,
        inputCost: 3.00,
        outputCost: 15.00,
        isMultimodal: true,
        isVisionCapable: true,
        isOmniCapable: false,
        tags: ['reasoning', 'coding', 'multimodal', 'latest'],
      },
      {
        id: 'claude-3-haiku-20240307',
        name: 'claude-3-haiku-20240307',
        displayName: 'Claude 3 Haiku',
        description: 'Fastest and most affordable Claude model',
        contextLength: 200000,
        inputCost: 0.25,
        outputCost: 1.25,
        isMultimodal: true,
        isVisionCapable: true,
        isOmniCapable: false,
        tags: ['fast', 'affordable', 'multimodal'],
      },
      {
        id: 'claude-3-opus-20240229',
        name: 'claude-3-opus-20240229',
        displayName: 'Claude 3 Opus',
        description: 'Most capable Claude 3 model for complex tasks',
        contextLength: 200000,
        inputCost: 15.00,
        outputCost: 75.00,
        isMultimodal: true,
        isVisionCapable: true,
        isOmniCapable: false,
        tags: ['reasoning', 'premium', 'multimodal'],
      },
    ],
  },
  google: {
    id: 'google',
    name: 'google',
    displayName: 'Google Gemini',
    description: 'Gemini models with strong multimodal capabilities',
    website: 'https://aistudio.google.com',
    keyName: 'GOOGLE_API_KEY',
    keyPlaceholder: 'AI...',
    baseUrl: 'https://generativelanguage.googleapis.com/v1',
    requiresKey: true,
    testEndpoint: '/models',
    pricing: {
      currency: 'USD',
      unit: '1M tokens',
    },
    models: [
      {
        id: 'gemini-1.5-pro',
        name: 'gemini-1.5-pro',
        displayName: 'Gemini 1.5 Pro',
        description: 'Advanced Gemini model with 2M context window',
        contextLength: 2000000,
        inputCost: 3.50,
        outputCost: 10.50,
        isMultimodal: true,
        isVisionCapable: true,
        isOmniCapable: true,
        tags: ['long-context', 'multimodal', 'reasoning'],
      },
      {
        id: 'gemini-1.5-flash',
        name: 'gemini-1.5-flash',
        displayName: 'Gemini 1.5 Flash',
        description: 'Fast and efficient Gemini model with long context window',
        contextLength: 1000000,
        inputCost: 0.075,
        outputCost: 0.30,
        isMultimodal: true,
        isVisionCapable: true,
        isOmniCapable: true,
        tags: ['fast', 'affordable', 'multimodal'],
      },
    ],
  },
  together: {
    id: 'together',
    name: 'together',
    displayName: 'Together AI',
    description: 'Wide selection of open-source models',
    website: 'https://api.together.xyz',
    keyName: 'TOGETHER_API_KEY',
    keyPlaceholder: '...',
    baseUrl: 'https://api.together.xyz/v1',
    requiresKey: true,
    testEndpoint: '/models',
    pricing: {
      currency: 'USD',
      unit: '1M tokens',
    },
    models: [
      {
        id: 'meta-llama/Llama-3-70b-chat-hf',
        name: 'meta-llama/Llama-3-70b-chat-hf',
        displayName: 'Llama 3 70B Chat',
        description: 'Meta\'s powerful Llama 3 model',
        contextLength: 131072,
        inputCost: 0.90,
        outputCost: 0.90,
        tags: ['reasoning', 'open-source'],
      },
      {
        id: 'mistralai/Mixtral-8x22B-Instruct-v0.1',
        name: 'mistralai/Mixtral-8x22B-Instruct-v0.1',
        displayName: 'Mixtral 8x22B',
        description: 'Large mixture of experts model',
        contextLength: 32768,
        inputCost: 1.20,
        outputCost: 1.20,
        tags: ['moe', 'open-source', 'large-context'],
      },
    ],
  },
};

export const getProviderById = (id: string): ApiProvider | undefined => {
  return API_PROVIDERS[id];
};

export const getAllProviders = (): ApiProvider[] => {
  return Object.values(API_PROVIDERS);
};

export const getProviderModels = (providerId: string) => {
  const provider = getProviderById(providerId);
  return provider?.models || [];
};

export const getModelById = (providerId: string, modelId: string) => {
  const provider = getProviderById(providerId);
  return provider?.models.find(model => model.id === modelId);
};

export const formatCost = (cost: number, currency = 'USD'): string => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(cost);
};

export const calculateCost = (
  inputTokens: number,
  outputTokens: number,
  inputCostPer1M: number,
  outputCostPer1M: number
): number => {
  const inputCost = (inputTokens / 1_000_000) * inputCostPer1M;
  const outputCost = (outputTokens / 1_000_000) * outputCostPer1M;
  return inputCost + outputCost;
};
