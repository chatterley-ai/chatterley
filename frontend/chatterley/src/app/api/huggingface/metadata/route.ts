/**
 * API route for fetching HuggingFace model metadata with authentication
 */

import { NextRequest, NextResponse } from 'next/server';
import { modelInfo } from '@huggingface/hub';

export async function POST(request: NextRequest) {
  try {
    const { modelName, username, token } = await request.json();

    if (!modelName || typeof modelName !== 'string') {
      return NextResponse.json(
        { error: 'Model name is required' },
        { status: 400 }
      );
    }

    // Prepare auth options if provided
    // We need to use a type assertion here because the modelInfo function expects specific parameters
    // that don't match our usage
    const authOptions = { name: modelName } as unknown as Parameters<typeof modelInfo>[0];
    
    if (username && token) {
      // We need to set credentials for authentication
      // Updating the type assertion to allow for credential property
      (authOptions as unknown as { credentials?: { accessToken: string } }).credentials = {
        accessToken: token,
      };
    }
    
    if (username && token) {
      authOptions.credentials = {
        accessToken: token,
      };
    }

    try {
      // Fetch model info from HuggingFace
      const hfModelInfo = await modelInfo(authOptions);
      
      // Extract parameter count from config or safetensors metadata
      let parameterCount = 0;
      let tags: string[] = [];
      let isSpecialist = false;

      // Extract tags safely
      if (hfModelInfo && typeof hfModelInfo === 'object' && 'tags' in hfModelInfo) {
        tags = (hfModelInfo as { tags?: string[] }).tags || [];
      }
      
      // Check if it's a specialist model based on tags and model card
      const specialistKeywords = ['tool', 'function-calling', 'reasoning', 'code-only', 'math-only', 'tool-use', 'code', 'coding', 'coalm', 'coder', 'starcoder', 'codellama'];
      isSpecialist = tags.some((tag: string) => 
        specialistKeywords.some(keyword => tag.toLowerCase().includes(keyword))
      ) || specialistKeywords.some(keyword => 
        modelName.toLowerCase().includes(keyword)
      );

      // Try to extract parameter count from safetensors metadata
      if (hfModelInfo && typeof hfModelInfo === 'object' && 'safetensors' in hfModelInfo) {
        const safetensors = (hfModelInfo as { safetensors?: { parameters?: Record<string, number>; total?: number } }).safetensors;
        if (safetensors && typeof safetensors === 'object' && 'parameters' in safetensors && safetensors.parameters) {
          // safetensors.parameters is a Record<string, number>, so we need to sum the values
          const totalParameters = Object.values(safetensors.parameters).reduce((sum: number, val: number) => sum + val, 0);
          parameterCount = Math.round(totalParameters / 1e9 * 100) / 100; // Convert to billions
        }
      }
      
      // If no safetensors info, try to extract from config
      if (!parameterCount && hfModelInfo && typeof hfModelInfo === 'object' && 'config' in hfModelInfo) {
        const config = (hfModelInfo as { config?: Record<string, unknown> }).config;
        if (config && typeof config === 'object' && 'num_parameters' in config && typeof config.num_parameters === 'number') {
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
      };
      
      return NextResponse.json({ success: true, metadata });
      
    } catch (hfError: unknown) {
      const errorMessage = hfError instanceof Error ? hfError.message : 'Unknown error fetching metadata';
      console.warn(`Failed to fetch metadata for ${modelName}:`, errorMessage);
      
      return NextResponse.json(
        { 
          success: false, 
          error: errorMessage,
          fallback: {
            parameterCount: 0,
            tags: [],
            isSpecialist: false,
            error: errorMessage,
            lastUpdated: new Date().toISOString(),
          }
        },
        { status: 200 } // Don't treat as HTTP error, just failed metadata fetch
      );
    }
    
  } catch (error: unknown) {
    console.error('HuggingFace metadata API error:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}