#!/usr/bin/env node
/**
 * Config Discovery Script - generates static config metadata for Electron app
 * This runs at build time to create a configs.json file that can be used
 * before the Python server starts.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { modelInfo } = require('@huggingface/hub');

// Path resolution helper so the script works from the new repo layout
const resolveOumiRoot = () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const newLayout = path.join(repoRoot, 'backend', 'oumi');

  if (fs.existsSync(newLayout)) {
    return newLayout;
  }

  // Legacy support when frontend and backend lived under oumi/
  const legacyLayout = path.resolve(__dirname, '../../../oumi');
  if (fs.existsSync(path.join(legacyLayout, 'configs'))) {
    return legacyLayout;
  }

  throw new Error('Unable to locate Oumi backend. Expected backend/oumi or legacy oumi/.');
};

// Path to the Oumi configs directory (relative to the Oumi root)
const OUMI_ROOT = resolveOumiRoot();
const CONFIGS_DIR = path.join(OUMI_ROOT, 'configs');
const OUTPUT_FILE = path.join(__dirname, '../public/static-configs.json');
const MODEL_CACHE_FILE = path.join(__dirname, '../cache/model-metadata.json');

// Cache for model metadata to avoid repeated API calls
let modelCache = {};

// Load existing cache if it exists
function loadModelCache() {
  try {
    if (fs.existsSync(MODEL_CACHE_FILE)) {
      const cacheData = fs.readFileSync(MODEL_CACHE_FILE, 'utf8');
      modelCache = JSON.parse(cacheData);
      console.log(`📦 Loaded ${Object.keys(modelCache).length} cached model metadata entries`);
    }
  } catch (error) {
    console.warn('⚠️  Failed to load model cache:', error.message);
    modelCache = {};
  }
}

// Save cache to disk
function saveModelCache() {
  try {
    const cacheDir = path.dirname(MODEL_CACHE_FILE);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    fs.writeFileSync(MODEL_CACHE_FILE, JSON.stringify(modelCache, null, 2));
    console.log(`💾 Saved ${Object.keys(modelCache).length} model metadata entries to cache`);
  } catch (error) {
    console.warn('⚠️  Failed to save model cache:', error.message);
  }
}

console.log('🔍 Discovering Oumi configurations...');
console.log('Oumi root:', OUMI_ROOT);
console.log('Configs directory:', CONFIGS_DIR);

// Fetch model metadata from Hugging Face API
async function fetchModelMetadata(modelName) {
  if (!modelName || typeof modelName !== 'string') {
    return null;
  }

  // Check cache first
  if (modelCache[modelName]) {
    return modelCache[modelName];
  }

  try {
    console.log(`🔍 Fetching metadata for ${modelName}...`);
    
    // Use HF token if available (supports public/gated models)
    const hfToken = process.env.HF_TOKEN 
      || process.env.HUGGINGFACE_TOKEN 
      || process.env.HUGGINGFACE_HUB_TOKEN;

    let hfModelInfo;
    try {
      // Prefer object signature used by newer @huggingface/hub versions
      hfModelInfo = await modelInfo({ 
        repo: modelName,
        credentials: hfToken ? { accessToken: hfToken } : undefined,
      });
    } catch (sigErr) {
      // Fallback to legacy signature (repoId: string, options?: { token })
      hfModelInfo = await modelInfo(modelName, hfToken ? { token: hfToken } : undefined);
    }
    
    // Extract parameter count from config or safetensors metadata
    let parameterCount = 0;
    let tags = hfModelInfo.tags || [];
    let isSpecialist = false;
    
    // Check if it's a specialist model based on tags and model card
    const specialistKeywords = ['tool', 'function-calling', 'reasoning', 'code-only', 'math-only', 'tool-use'];
    isSpecialist = tags.some(tag => 
      specialistKeywords.some(keyword => tag.toLowerCase().includes(keyword))
    ) || specialistKeywords.some(keyword => 
      modelName.toLowerCase().includes(keyword)
    );

    // Try to extract parameter count from safetensors metadata
    if (hfModelInfo.safetensors && hfModelInfo.safetensors.parameters) {
      parameterCount = Math.round(hfModelInfo.safetensors.parameters / 1e9 * 100) / 100; // Convert to billions
    }
    
    // If no safetensors info, try to extract from config
    if (!parameterCount && hfModelInfo.config) {
      const config = hfModelInfo.config;
      if (config.num_parameters) {
        parameterCount = Math.round(config.num_parameters / 1e9 * 100) / 100;
      }
    }
    
    // If still no parameter count, try parsing from model name
    if (!parameterCount) {
      const paramMatch = modelName.match(/(\d+(?:\.\d+)?)\s*([bmk])/i);
      if (paramMatch) {
        const num = parseFloat(paramMatch[1]);
        const unit = paramMatch[2].toLowerCase();
        if (unit === 'b') parameterCount = num;
        else if (unit === 'm') parameterCount = num / 1000;
        else if (unit === 'k') parameterCount = num / 1000000;
      }
    }
    
    const metadata = {
      parameterCount,
      tags,
      isSpecialist,
      lastUpdated: new Date().toISOString(),
      // Cache for 24 hours
      expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    };
    
    // Store in cache
    modelCache[modelName] = metadata;
    
    return metadata;
    
  } catch (error) {
    console.warn(`⚠️  Failed to fetch metadata for ${modelName}:`, error.message);
    
    // Store a basic fallback entry to avoid repeated failed requests
    const fallbackMetadata = {
      parameterCount: 0,
      tags: [],
      isSpecialist: false,
      error: error.message,
      lastUpdated: new Date().toISOString(),
      expires: new Date(Date.now() + 60 * 60 * 1000).toISOString() // Cache errors for 1 hour
    };
    
    modelCache[modelName] = fallbackMetadata;
    return fallbackMetadata;
  }
}

function extractModelFamily(configPath) {
  // Try to match recipes/{family} pattern
  let match = configPath.match(/recipes[/\\]([^/\\]+)/);
  if (match) return match[1];
  
  // Try to match apis/{provider} pattern  
  match = configPath.match(/apis[/\\]([^/\\]+)/);
  if (match) return match[1];
  
  // Try to match projects/{name} pattern
  match = configPath.match(/projects[/\\]([^/\\]+)/);
  if (match) return match[1];
  
  return 'unknown';
}

function categorizeModelSizeFromParams(parameterCount) {
  if (!parameterCount || parameterCount <= 0) {
    return 'unknown';
  }
  
  // Use new size categories: ≤3B = small, ≤30B = medium, >30B = large
  if (parameterCount <= 3) return 'small';
  if (parameterCount <= 30) return 'medium';
  return 'large';
}

function categorizeModelSize(displayName, parameterCount = null) {
  // If we have parameter count from HF API, use that
  if (parameterCount && parameterCount > 0) {
    return categorizeModelSizeFromParams(parameterCount);
  }
  
  // Fallback to string matching with improved patterns
  const name = displayName.toLowerCase();
  if (name.includes('135m') || name.includes('1b') || name.includes('3b')) return 'small';
  if (name.includes('7b') || name.includes('8b')) return 'medium';
  if (name.includes('20b') || name.includes('30b') || name.includes('32b') || name.includes('70b')) return 'large';
  if (name.includes('120b') || name.includes('405b')) return 'large'; // No more 'xl' category
  return 'medium';
}

function isRecommended(config, metadata = null) {
  const name = config.display_name.toLowerCase();
  const engine = config.engine ? config.engine.toLowerCase() : 'unknown';
  
  // Don't recommend specialist models for general chat
  if (metadata && metadata.isSpecialist) {
    return false;
  }
  
  // Get parameter count for better recommendations
  const parameterCount = metadata ? metadata.parameterCount : 0;
  const sizeCategory = categorizeModelSize(config.display_name, parameterCount);
  
  // Recommend GGUF configs for macOS (efficient)
  if (name.includes('gguf') && name.includes('macos')) {
    // Only if they're not too large
    return sizeCategory === 'small' || sizeCategory === 'medium';
  }
  
  // Recommend smaller native models for general use
  if (sizeCategory === 'small' && engine === 'native') return true;
  if (sizeCategory === 'medium' && engine === 'native') return true;
  
  // Recommend instruct models over base models (but not if they're huge)
  if (name.includes('instruct') && sizeCategory !== 'large') return true;
  
  return false;
}

function parseYamlConfig(filePath, relativePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const config = yaml.load(content);
    
    // Extract key information from the YAML config
    const modelName = config.model?.model_name || 'Unknown Model';
    const engine = config.engine || 'NATIVE';
    const contextLength = config.model?.model_max_length || 2048;
    
    // Create display name from path
    const pathParts = relativePath.split(/[/\\]/);
    const fileName = path.basename(filePath, path.extname(filePath));
    const family = extractModelFamily(relativePath);
    
    // Clean up the filename for display
    let cleanFileName = fileName.replace(/_infer$/, '');
    
    // Create more readable display name
    let displayName;
    if (family === 'openai' || family === 'anthropic' || family === 'gemini' || family === 'vertex') {
      // For API configs, use provider + model name
      displayName = `${family.toUpperCase()} - ${cleanFileName}`;
    } else {
      // For local models, use family + config name
      displayName = `${family} - ${cleanFileName}`;
    }
    
    return {
      id: relativePath.replace(/[/\\]/g, '_').replace(/\.(yaml|yml)$/, ''),
      config_path: relativePath, // Use relative path for built app compatibility
      relative_path: relativePath,
      display_name: displayName,
      model_name: modelName,
      engine: engine,
      context_length: contextLength,
      model_family: extractModelFamily(relativePath),
      size_category: categorizeModelSize(displayName)
    };
  } catch (error) {
    console.warn(`⚠️  Failed to parse config ${filePath}:`, error.message);
    return null;
  }
}

const DIFFUSERS_ENGINES = new Set(['DIFFUSERS_IMAGE', 'DIFFUSERS_AUDIO', 'DIFFUSERS_VIDEO']);

function normalizeRelativePath(relativePath) {
  return relativePath.replace(/\\/g, '/');
}

function parseJsonConfig(filePath, relativePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const config = JSON.parse(content);

    const engineRaw = config.engine || config.engine_type || 'NATIVE';
    const engine = typeof engineRaw === 'string' ? engineRaw.toUpperCase() : 'NATIVE';

    if (!DIFFUSERS_ENGINES.has(engine)) {
      // Only surface diffusers-style configs from JSON sources for now.
      return null;
    }

    const modelName = config.model?.model_name || config.model_name || 'Unknown Model';
    const contextLength = config.model?.model_max_length || config.context_length || 0;
    const normalizedPath = normalizeRelativePath(relativePath);
    const fileName = path.basename(filePath);
    const family = extractModelFamily(normalizedPath) || 'diffusers';
    const displayName = config.display_name
      || `${family} - ${fileName.replace(/\.[^.]+$/, '')}`;

    return {
      id: normalizedPath.replace(/[/\\]/g, '_').replace(/\.[^.]+$/, ''),
      config_path: normalizedPath,
      relative_path: normalizedPath,
      display_name: displayName,
      model_name: modelName,
      engine,
      context_length: contextLength,
      model_family: family,
      filename: fileName,
      size_category: categorizeModelSize(displayName)
    };
  } catch (error) {
    console.warn(`⚠️  Failed to parse JSON config ${filePath}:`, error.message);
    return null;
  }
}

async function discoverConfigs(dir, baseDir = dir) {
  const configs = [];
  
  if (!fs.existsSync(dir)) {
    console.warn(`⚠️  Configs directory not found: ${dir}`);
    return configs;
  }
  
  const files = fs.readdirSync(dir);
  
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      // Recursively search subdirectories
      configs.push(...await discoverConfigs(fullPath, baseDir));
    } else if (file.match(/\.(yaml|yml)$/)) {
      // Only process inference configs (not training configs)
      const relativePath = normalizeRelativePath(path.relative(baseDir, fullPath));
      if (relativePath.includes('inference') || relativePath.includes('infer')) {
        const configData = parseYamlConfig(fullPath, relativePath);
        if (configData) {
          configs.push(configData);
        }
      }
    } else if (file.toLowerCase().endsWith('.json')) {
      const relativePath = normalizeRelativePath(path.relative(baseDir, fullPath));
      const configData = parseJsonConfig(fullPath, relativePath);
      if (configData) {
        configs.push(configData);
      }
    }
  }
  
  return configs;
}

async function enhanceConfigsWithMetadata(configs) {
  console.log('🤖 Enhancing configs with Hugging Face metadata...');
  
  const enhancedConfigs = [];
  const uniqueModels = new Set();
  
  // Collect unique model names to avoid duplicate API calls
  configs.forEach(config => {
    if (config.model_name) {
      uniqueModels.add(config.model_name);
    }
  });
  
  console.log(`📊 Fetching metadata for ${uniqueModels.size} unique models...`);
  
  // Fetch metadata for all unique models (with rate limiting)
  const metadataPromises = Array.from(uniqueModels).map(async (modelName, index) => {
    // Add a small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, index * 200));
    const metadata = await fetchModelMetadata(modelName);
    return [modelName, metadata];
  });
  
  const metadataResults = await Promise.all(metadataPromises);
  const metadataMap = new Map(metadataResults);
  
  // Enhance each config with metadata
  for (const config of configs) {
    const metadata = metadataMap.get(config.model_name);
    
    // Update size category based on actual parameter count
    if (metadata && metadata.parameterCount > 0) {
      config.size_category = categorizeModelSizeFromParams(metadata.parameterCount);
      config.parameter_count = metadata.parameterCount;
      config.is_specialist = metadata.isSpecialist;
      config.hf_tags = metadata.tags;
    } else {
      // Fallback to string-based categorization
      config.size_category = categorizeModelSize(config.display_name);
      config.parameter_count = null;
      config.is_specialist = false;
      config.hf_tags = [];
    }
    
    // Set recommendation status
    config.recommended = isRecommended(config, metadata);
    
    enhancedConfigs.push(config);
  }
  
  return enhancedConfigs;
}

async function main() {
  try {
    // Load existing cache
    loadModelCache();
    
    console.log('📁 Scanning configs directory...');
    const configs = await discoverConfigs(CONFIGS_DIR);
    
    console.log(`✅ Found ${configs.length} inference configurations`);
    
    // Enhance configs with HuggingFace metadata
    const enhancedConfigs = await enhanceConfigsWithMetadata(configs);
    
    console.log(`🚀 Enhanced ${enhancedConfigs.length} configurations with metadata`);
    
    // Sort configs by family and name
    enhancedConfigs.sort((a, b) => {
      if (a.recommended && !b.recommended) return -1;
      if (!a.recommended && b.recommended) return 1;
      
      if (a.model_family !== b.model_family) {
        return a.model_family.localeCompare(b.model_family);
      }
      
      return a.display_name.localeCompare(b.display_name);
    });
    
    // Save the enhanced metadata cache
    saveModelCache();
    
    // Create the output structure
    const output = {
      generated_at: new Date().toISOString(),
      version: '2.0', // Updated version to indicate HF metadata integration
      total_configs: enhancedConfigs.length,
      configs: enhancedConfigs
    };
    
    // Ensure output directory exists
    const outputDir = path.dirname(OUTPUT_FILE);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Write the configs file
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
    
    console.log(`📄 Generated static configs file: ${OUTPUT_FILE}`);
    console.log(`🎯 Configs by family:`);
    
    const families = enhancedConfigs.reduce((acc, config) => {
      acc[config.model_family] = (acc[config.model_family] || 0) + 1;
      return acc;
    }, {});
    
    Object.entries(families)
      .sort(([,a], [,b]) => b - a)
      .forEach(([family, count]) => {
        console.log(`   ${family}: ${count} configs`);
      });
      
    console.log('\n🚀 Static config discovery complete!');
    
  } catch (error) {
    console.error('❌ Error generating static configs:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { discoverConfigs, parseYamlConfig };
