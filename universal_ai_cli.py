#!/usr/bin/env python3
"""
Universal AI CLI Integration for Claude Code
A multi-provider CLI wrapper that exposes multiple AI model capabilities to AI coding assistants.
Supports ASI:One, OpenAI, Anthropic, Google, and other OpenAI-compatible APIs.
"""

import os
import sys
import json
import argparse
from typing import Optional, List, Dict, Any, Iterator
import requests

# Provider configurations
PROVIDERS = {
    "fetch.ai": {
        "api_url": "https://api.asi1.ai/v1/chat/completions",
        "models": ["fetch.ai", "fetch.ai-ultra", "fetch.ai-mini"],
        "default_model": "fetch.ai",
        "env_key": "ASI_ONE_API_KEY",
        "supports_streaming": True
    },
    "openai": {
        "api_url": "https://api.openai.com/v1/chat/completions",
        "models": ["gpt-4", "gpt-4-turbo", "gpt-3.5-turbo"],
        "default_model": "gpt-4-turbo",
        "env_key": "OPENAI_API_KEY",
        "supports_streaming": True
    },
    "anthropic": {
        "api_url": "https://api.anthropic.com/v1/messages",
        "models": ["claude-3-opus-20240229", "claude-3-sonnet-20240229", "claude-3-haiku-20240307"],
        "default_model": "claude-3-sonnet-20240229",
        "env_key": "ANTHROPIC_API_KEY",
        "supports_streaming": True,
        "custom_format": True
    },
    "google": {
        "api_url": "https://google.leaksnipe.win/v1beta/models/",
        "models": ["gemini-pro", "gemini-pro-vision"],
        "default_model": "gemini-pro",
        "env_key": "GOOGLE_API_KEY",
        "supports_streaming": True,
        "custom_format": True
    },
    "cohere": {
        "api_url": "https://api.cohere.ai/v1/chat",
        "models": ["command", "command-light", "command-nightly"],
        "default_model": "command",
        "env_key": "COHERE_API_KEY",
        "supports_streaming": True
    },
    "together": {
        "api_url": "https://api.together.xyz/v1/chat/completions",
        "models": ["meta-llama/Llama-2-70b-chat-hf", "mistralai/Mixtral-8x7B-Instruct-v0.1"],
        "default_model": "meta-llama/Llama-2-70b-chat-hf",
        "env_key": "TOGETHER_API_KEY",
        "supports_streaming": True
    },
    "groq": {
        "api_url": "https://api.groq.com/openai/v1/chat/completions",
        "models": ["llama2-70b-4096", "mixtral-8x7b-32768"],
        "default_model": "llama2-70b-4096",
        "env_key": "GROQ_API_KEY",
        "supports_streaming": True
    }
}

DEFAULT_TEMP = 0.7
DEFAULT_MAX_TOKENS = 2048


class UniversalAIClient:
    """Universal client for interacting with multiple AI provider APIs"""
    
    def __init__(self, provider: str = "fetch.ai", api_key: Optional[str] = None):
        if provider not in PROVIDERS:
            raise ValueError(f"Unsupported provider: {provider}. Available: {list(PROVIDERS.keys())}")
        
        self.provider = provider
        self.config = PROVIDERS[provider]
        self.api_key = api_key or os.getenv(self.config["env_key"])
        
        if not self.api_key:
            raise ValueError(f"{self.config['env_key']} environment variable or api_key parameter is required")
        
        self.api_url = self.config["api_url"]
        self.custom_format = self.config.get("custom_format", False)
        
        # Set up headers based on provider
        self.headers = self._get_headers()
    
    def _get_headers(self) -> Dict[str, str]:
        """Get provider-specific headers"""
        headers = {
            'Content-Type': 'application/json',
        }
        
        if self.provider == "anthropic":
            headers["x-api-key"] = self.api_key
            headers["anthropic-version"] = "2023-06-01"
        elif self.provider == "google":
            # Google uses API key in URL, not headers
            pass
        else:
            headers["Authorization"] = f"Bearer {self.api_key}"
        
        return headers
    
    def _format_request(
        self,
        messages: List[Dict[str, str]],
        model: str,
        temperature: float,
        max_tokens: int,
        stream: bool
    ) -> Dict[str, Any]:
        """Format request payload based on provider"""
        
        if self.provider == "anthropic":
            # Anthropic uses different format
            system_message = None
            user_messages = []
            
            for msg in messages:
                if msg["role"] == "system":
                    system_message = msg["content"]
                else:
                    user_messages.append({
                        "role": msg["role"],
                        "content": msg["content"]
                    })
            
            payload = {
                "model": model,
                "messages": user_messages,
                "max_tokens": max_tokens,
                "stream": stream
            }
            
            if system_message:
                payload["system"] = system_message
            
        elif self.provider == "google":
            # Google uses different format
            user_content = messages[-1]["content"] if messages else ""
            payload = {
                "contents": [{
                    "parts": [{"text": user_content}]
                }],
                "generationConfig": {
                    "temperature": temperature,
                    "maxOutputTokens": max_tokens
                }
            }
        else:
            # OpenAI-compatible format (ASI:One, OpenAI, Cohere, Together, Groq)
            payload = {
                "model": model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
                "stream": stream
            }
        
        return payload
    
    def _get_endpoint_url(self, model: str) -> str:
        """Get full endpoint URL, handling provider-specific patterns"""
        if self.provider == "google":
            return f"{self.api_url}{model}:generateContent?key={self.api_key}"
        return self.api_url
    
    def chat_completion(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        temperature: float = DEFAULT_TEMP,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        stream: bool = False
    ) -> Dict[str, Any]:
        """
        Make a chat completion request to the selected provider's API
        
        Args:
            messages: List of message dictionaries with 'role' and 'content'
            model: Model to use (uses provider default if not specified)
            temperature: Sampling temperature (0.0-2.0)
            max_tokens: Maximum tokens to generate
            stream: Whether to stream the response
        
        Returns:
            API response as dictionary
        """
        model = model or self.config["default_model"]
        
        if model not in self.config["models"] and not self.custom_format:
            print(f"Warning: Model '{model}' not in known models for {self.provider}", file=sys.stderr)
        
        payload = self._format_request(messages, model, temperature, max_tokens, stream)
        url = self._get_endpoint_url(model)
        
        response = requests.post(
            url,
            headers=self.headers,
            json=payload,
            stream=stream
        )
        
        response.raise_for_status()
        return response.json() if not stream else response
    
    def stream_completion(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        temperature: float = DEFAULT_TEMP,
        max_tokens: int = DEFAULT_MAX_TOKENS
    ) -> Iterator[str]:
        """
        Stream chat completion response from the selected provider's API
        
        Args:
            messages: List of message dictionaries with 'role' and 'content'
            model: Model to use (uses provider default if not specified)
            temperature: Sampling temperature (0.0-2.0)
            max_tokens: Maximum tokens to generate
        
        Yields:
            Content chunks as they arrive
        """
        response = self.chat_completion(
            messages=messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            stream=True
        )
        
        for line in response.iter_lines():
            if line:
                line_text = line.decode('utf-8')
                
                # Handle different streaming formats
                if self.provider == "anthropic":
                    if line_text.startswith('data: '):
                        data_str = line_text[6:]
                        if data_str == '[DONE]':
                            break
                        try:
                            data = json.loads(data_str)
                            if data.get('type') == 'content_block_delta':
                                delta = data.get('delta', {})
                                if 'text' in delta:
                                    yield delta['text']
                        except json.JSONDecodeError:
                            pass
                
                elif self.provider == "google":
                    # Google streaming format
                    try:
                        data = json.loads(line_text)
                        if 'candidates' in data and len(data['candidates']) > 0:
                            content = data['candidates'][0].get('content', {})
                            if 'parts' in content and len(content['parts']) > 0:
                                text = content['parts'][0].get('text', '')
                                if text:
                                    yield text
                    except json.JSONDecodeError:
                        pass
                
                else:
                    # OpenAI-compatible streaming format
                    if line_text.startswith('data: '):
                        data_str = line_text[6:]
                        if data_str == '[DONE]':
                            break
                        try:
                            data = json.loads(data_str)
                            if 'choices' in data and len(data['choices']) > 0:
                                delta = data['choices'][0].get('delta', {})
                                if 'content' in delta:
                                    yield delta['content']
                        except json.JSONDecodeError:
                            pass


def format_messages(prompt: str, conversation_history: Optional[List[Dict[str, str]]] = None) -> List[Dict[str, str]]:
    """
    Format messages for API request
    
    Args:
        prompt: User's prompt
        conversation_history: Optional list of previous messages
    
    Returns:
        Formatted messages list
    """
    messages = conversation_history or []
    messages.append({"role": "user", "content": prompt})
    return messages


def list_providers():
    """List all available providers and their models"""
    print("Available AI Providers:")
    print("=" * 60)
    for provider, config in PROVIDERS.items():
        print(f"\n{provider.upper()}:")
        print(f"  API Key: {config['env_key']}")
        print(f"  Default Model: {config['default_model']}")
        print(f"  Available Models: {', '.join(config['models'][:3])}{'...' if len(config['models']) > 3 else ''}")
        print(f"  Streaming: {'✓' if config['supports_streaming'] else '✗'}")


def main():
    """Main CLI entry point"""
    parser = argparse.ArgumentParser(
        description='Universal AI CLI - Interact with multiple AI providers from command line',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # ASI:One query
  python universal_ai_cli.py "What is agentic AI?" --provider asi1
  
  # OpenAI with streaming
  python universal_ai_cli.py "Explain blockchain" --provider openai --stream
  
  # Anthropic interactive mode
  python universal_ai_cli.py --provider anthropic --interactive
  
  # List all providers
  python universal_ai_cli.py --list-providers
  
  # Custom model
  python universal_ai_cli.py "Write code" --provider openai --model gpt-4
        """
    )
    
    parser.add_argument(
        'prompt',
        nargs='?',
        help='Prompt to send to AI provider (omit for interactive mode)'
    )
    
    parser.add_argument(
        '--provider', '-p',
        choices=list(PROVIDERS.keys()),
        default='fetch.ai',
        help=f'AI provider to use (default: asi1)'
    )
    
    parser.add_argument(
        '--model', '-m',
        help='Model to use (provider-specific)'
    )
    
    parser.add_argument(
        '--temperature', '--temp', '-t',
        type=float,
        default=DEFAULT_TEMP,
        help=f'Sampling temperature 0.0-2.0 (default: {DEFAULT_TEMP})'
    )
    
    parser.add_argument(
        '--max-tokens',
        type=int,
        default=DEFAULT_MAX_TOKENS,
        help=f'Maximum tokens to generate (default: {DEFAULT_MAX_TOKENS})'
    )
    
    parser.add_argument(
        '--stream', '-s',
        action='store_true',
        help='Stream the response as it generates'
    )
    
    parser.add_argument(
        '--interactive', '-i',
        action='store_true',
        help='Interactive conversation mode'
    )
    
    parser.add_argument(
        '--output', '-o',
        help='Save response to file'
    )
    
    parser.add_argument(
        '--json',
        action='store_true',
        help='Output raw JSON response'
    )
    
    parser.add_argument(
        '--list-providers',
        action='store_true',
        help='List all available providers and exit'
    )
    
    args = parser.parse_args()
    
    # List providers and exit
    if args.list_providers:
        list_providers()
        return
    
    try:
        client = UniversalAIClient(provider=args.provider)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        print(f"\nAvailable providers: {', '.join(PROVIDERS.keys())}", file=sys.stderr)
        print("Use --list-providers to see all available providers and models.", file=sys.stderr)
        sys.exit(1)
    
    # Interactive mode
    if args.interactive:
        conversation_history = []
        print(f"Universal AI CLI - {args.provider.upper()} Interactive Mode (Ctrl+C to exit)")
        print("=" * 60)
        
        try:
            while True:
                try:
                    user_input = input("\nYou: ")
                    if not user_input.strip():
                        continue
                    
                    messages = format_messages(user_input, conversation_history)
                    
                    print(f"{args.provider.upper()}: ", end='', flush=True)
                    full_response = ""
                    
                    for chunk in client.stream_completion(
                        messages=messages,
                        model=args.model,
                        temperature=args.temperature,
                        max_tokens=args.max_tokens
                    ):
                        print(chunk, end='', flush=True)
                        full_response += chunk
                    
                    print()  # New line after completion
                    
                    # Add to conversation history
                    conversation_history.append({"role": "user", "content": user_input})
                    conversation_history.append({"role": "assistant", "content": full_response})
                    
                except KeyboardInterrupt:
                    print("\n\nExiting interactive mode...")
                    break
                    
        except EOFError:
            print("\n\nExiting interactive mode...")
        
        return
    
    # Single query mode
    if not args.prompt:
        parser.print_help()
        sys.exit(1)
    
    messages = format_messages(args.prompt)
    
    if args.stream:
        # Stream response
        full_response = ""
        for chunk in client.stream_completion(
            messages=messages,
            model=args.model,
            temperature=args.temperature,
            max_tokens=args.max_tokens
        ):
            print(chunk, end='', flush=True)
            full_response += chunk
        
        print()  # New line after completion
    else:
        # Non-streaming response
        response = client.chat_completion(
            messages=messages,
            model=args.model,
            temperature=args.temperature,
            max_tokens=args.max_tokens
        )
        
        if args.json:
            print(json.dumps(response, indent=2))
        else:
            # Extract content from different response formats
            content = ""
            if args.provider == "anthropic":
                if 'content' in response and len(response['content']) > 0:
                    content = response['content'][0].get('text', '')
            elif args.provider == "google":
                if 'candidates' in response and len(response['candidates']) > 0:
                    content = response['candidates'][0].get('content', {}).get('parts', [{}])[0].get('text', '')
            else:
                # OpenAI-compatible format
                if 'choices' in response and len(response['choices']) > 0:
                    content = response['choices'][0]['message']['content']
            
            if content:
                print(content)
                full_response = content
            else:
                print("No response content found")
                full_response = ""
    
    # Save to file if requested
    if args.output and 'full_response' in locals():
        try:
            with open(args.output, 'w') as f:
                f.write(full_response)
            print(f"\nResponse saved to {args.output}", file=sys.stderr)
        except IOError as e:
            print(f"Error saving to file: {e}", file=sys.stderr)


if __name__ == '__main__':
    main()
