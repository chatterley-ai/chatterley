# Copyright 2025 - Oumi
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Configuration management endpoints for Oumi WebChat server."""

import json
import os
from pathlib import Path
from typing import Dict, List, Optional, Any

import yaml

from aiohttp import web

from oumi.utils.logging import logger


class ConfigHandler:
    """Handles configuration management for Oumi WebChat."""
    
    def __init__(self, base_dir: Optional[str] = None):
        """Initialize config handler.
        
        Args:
            base_dir: Optional base directory for config files
        """
        self.base_dir = base_dir
    
    async def handle_get_configs_api(self, request: web.Request) -> web.Response:
        """Handle getting available inference configuration files.
        
        Args:
            request: Web request
            
        Returns:
            JSON response with available config files
        """
        # Trace id for correlation
        try:
            trace_id = request.get('trace_id') or request.headers.get('X-Trace-ID')
        except Exception:
            trace_id = None
        try:
            logger.info(f"[trace:{trace_id}] 📁 Listing available inference configs")
            configs = self._scan_inference_config_files()
            resp = {"configs": configs}
            if trace_id:
                resp["trace_id"] = trace_id
            return web.json_response(resp)
        except Exception as e:
            logger.error(f"[trace:{trace_id}] Error getting configs: {e}")
            payload = {"error": "Failed to scan configuration files"}
            if trace_id:
                payload["trace_id"] = trace_id
            return web.json_response(payload, status=500)
    
    def _scan_inference_config_files(self) -> List[Dict[str, Any]]:
        """Scan the configs directory for inference YAML files (*_infer.yaml).
        
        Returns:
            List of config file information
        """
        configs = []
        
        # Get the configs directory relative to this file
        if self.base_dir:
            current_dir = Path(self.base_dir)
        else:
            current_dir = Path(__file__).parent.parent.parent.parent  # Go up to oumi root
            
        configs_dir = current_dir / "configs" / "recipes"
        
        if not configs_dir.exists():
            logger.warning(f"Configs directory not found: {configs_dir}")
            return configs
            
        logger.debug(f"📁 Scanning configs directory: {configs_dir}")
        
        # Walk through all subdirectories looking for *_infer.yaml files
        for root, dirs, files in os.walk(configs_dir):
            for file in files:
                file_path = Path(root) / file
                relative_path = file_path.relative_to(configs_dir)

                is_yaml = file.endswith(("_infer.yaml", "_infer.yml"))
                is_json = file.endswith(".json")

                if not (is_yaml or is_json):
                    continue

                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        if is_yaml:
                            config_data = yaml.safe_load(f)
                        else:
                            config_data = json.load(f)
                except Exception as exc:
                    logger.warning("Failed to parse config %s: %s", file_path, exc)
                    continue

                if not isinstance(config_data, dict):
                    logger.debug("Skipping config %s; expected object at root", file_path)
                    continue

                engine = str(config_data.get('engine', 'UNKNOWN')) if config_data.get('engine') else 'UNKNOWN'

                # Only include JSON configs when they explicitly opt into a supported engine (e.g. Diffusers)
                if is_json and engine.upper() not in {"DIFFUSERS_IMAGE", "DIFFUSERS"}:
                    continue

                model_section = config_data.get('model') if isinstance(config_data.get('model'), dict) else {}
                model_name = model_section.get('model_name', 'Unknown')
                context_length = model_section.get('model_max_length', 4096)

                if (context_length is None or isinstance(context_length, str)) and engine.upper().startswith('DIFFUSERS'):
                    context_length = 0

                path_parts = str(relative_path).split('/')
                model_family = path_parts[0] if path_parts else 'unknown'

                display_name = str(relative_path).replace('/', ' > ')
                if is_yaml:
                    display_name = display_name.replace('_infer.yaml', '').replace('_infer.yml', '')
                else:
                    display_name = display_name.replace('.json', '')

                config_info = {
                    'id': str(relative_path),
                    'config_path': str(file_path),
                    'relative_path': str(relative_path),
                    'display_name': display_name,
                    'model_name': model_name,
                    'engine': engine,
                    'context_length': context_length or 0,
                    'model_family': model_family,
                    'filename': file,
                }

                configs.append(config_info)

        logger.debug(f"📋 Found {len(configs)} inference configurations")
        return sorted(configs, key=lambda x: (x['model_family'], x['display_name']))
