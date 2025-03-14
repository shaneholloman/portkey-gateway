// Docs for REST API
// https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/send-multimodal-prompts#gemini-send-multimodal-samples-drest

import { GOOGLE_VERTEX_AI } from '../../globals';
import {
  ContentType,
  Message,
  Params,
  Tool,
  ToolCall,
  SYSTEM_MESSAGE_ROLES,
  MESSAGE_ROLES,
} from '../../types/requestBody';
import {
  AnthropicChatCompleteResponse,
  AnthropicChatCompleteStreamResponse,
  AnthropicErrorResponse,
} from '../anthropic/chatComplete';
import {
  GoogleMessage,
  GoogleMessageRole,
  GoogleToolConfig,
  SYSTEM_INSTRUCTION_DISABLED_MODELS,
  transformOpenAIRoleToGoogleRole,
  transformToolChoiceForGemini,
} from '../google/chatComplete';
import {
  ChatCompletionResponse,
  ErrorResponse,
  Logprobs,
  ProviderConfig,
} from '../types';
import {
  generateErrorResponse,
  generateInvalidProviderResponseError,
} from '../utils';
import { transformGenerationConfig } from './transformGenerationConfig';
import type {
  GoogleErrorResponse,
  GoogleGenerateContentResponse,
  VertexLlamaChatCompleteStreamChunk,
  VertexLLamaChatCompleteResponse,
  GoogleSearchRetrievalTool,
} from './types';
import {
  getMimeType,
  recursivelyDeleteUnsupportedParameters,
  transformVertexLogprobs,
} from './utils';

export const buildGoogleSearchRetrievalTool = (tool: Tool) => {
  const googleSearchRetrievalTool: GoogleSearchRetrievalTool = {
    googleSearchRetrieval: {},
  };
  if (tool.function.parameters?.dynamicRetrievalConfig) {
    googleSearchRetrievalTool.googleSearchRetrieval.dynamicRetrievalConfig =
      tool.function.parameters.dynamicRetrievalConfig;
  }
  return googleSearchRetrievalTool;
};

export const VertexGoogleChatCompleteConfig: ProviderConfig = {
  // https://cloud.google.com/vertex-ai/generative-ai/docs/learn/model-versioning#gemini-model-versions
  model: {
    param: 'model',
    required: true,
    default: 'gemini-1.0-pro',
  },
  messages: [
    {
      param: 'contents',
      default: '',
      transform: (params: Params) => {
        let lastRole: GoogleMessageRole | undefined;
        const messages: GoogleMessage[] = [];

        params.messages?.forEach((message: Message) => {
          // From gemini-1.5 onwards, systemInstruction is supported
          // Skipping system message and sending it in systemInstruction for gemini 1.5 models
          if (
            SYSTEM_MESSAGE_ROLES.includes(message.role) &&
            !SYSTEM_INSTRUCTION_DISABLED_MODELS.includes(params.model as string)
          )
            return;

          const role = transformOpenAIRoleToGoogleRole(message.role);
          let parts = [];

          if (message.role === 'assistant' && message.tool_calls) {
            message.tool_calls.forEach((tool_call: ToolCall) => {
              parts.push({
                functionCall: {
                  name: tool_call.function.name,
                  args: JSON.parse(tool_call.function.arguments),
                },
              });
            });
          } else if (
            message.role === 'tool' &&
            typeof message.content === 'string'
          ) {
            parts.push({
              functionResponse: {
                name: message.name ?? 'gateway-tool-filler-name',
                response: {
                  content: message.content,
                },
              },
            });
          } else if (message.content && typeof message.content === 'object') {
            message.content.forEach((c: ContentType) => {
              if (c.type === 'text') {
                parts.push({
                  text: c.text,
                });
              }
              if (c.type === 'image_url') {
                const { url } = c.image_url || {};

                if (!url) {
                  // Shouldn't throw error?
                  return;
                }

                // Example: data:image/png;base64,abcdefg...
                if (url.startsWith('data:')) {
                  const [mimeTypeWithPrefix, base64Image] =
                    url.split(';base64,');
                  const mimeType = mimeTypeWithPrefix.split(':')[1];

                  parts.push({
                    inlineData: {
                      mimeType: mimeType,
                      data: base64Image,
                    },
                  });

                  return;
                } else if (
                  url.startsWith('gs://') ||
                  url.startsWith('https://') ||
                  url.startsWith('http://')
                ) {
                  parts.push({
                    fileData: {
                      mimeType: getMimeType(url),
                      fileUri: url,
                    },
                  });
                } else {
                  // NOTE: This block is kept to maintain backward compatibility
                  // Earlier we were assuming that all images will be base64 with image/jpeg mimeType
                  parts.push({
                    inlineData: {
                      mimeType: 'image/jpeg',
                      data: c.image_url?.url,
                    },
                  });
                }
              }
            });
          } else if (typeof message.content === 'string') {
            parts.push({
              text: message.content,
            });
          }

          // @NOTE: This takes care of the "Please ensure that multiturn requests alternate between user and model."
          // error that occurs when we have multiple user messages in a row.
          const shouldCombineMessages =
            lastRole === role && !params.model?.includes('vision');

          if (shouldCombineMessages) {
            messages[messages.length - 1].parts.push(...parts);
          } else {
            messages.push({ role, parts });
          }

          lastRole = role;
        });

        return messages;
      },
    },
    {
      param: 'systemInstruction',
      default: '',
      transform: (params: Params) => {
        // systemInstruction is only supported from gemini 1.5 models
        if (SYSTEM_INSTRUCTION_DISABLED_MODELS.includes(params.model as string))
          return;
        const firstMessage = params.messages?.[0] || null;
        if (!firstMessage) return;

        if (
          SYSTEM_MESSAGE_ROLES.includes(firstMessage.role) &&
          typeof firstMessage.content === 'string'
        ) {
          return {
            parts: [
              {
                text: firstMessage.content,
              },
            ],
            role: 'system',
          };
        }

        if (
          SYSTEM_MESSAGE_ROLES.includes(firstMessage.role) &&
          typeof firstMessage.content === 'object' &&
          firstMessage.content?.[0]?.text
        ) {
          return {
            parts: [
              {
                text: firstMessage.content?.[0].text,
              },
            ],
            role: 'system',
          };
        }

        return;
      },
    },
  ],
  temperature: {
    param: 'generationConfig',
    transform: (params: Params) => transformGenerationConfig(params),
  },
  top_p: {
    param: 'generationConfig',
    transform: (params: Params) => transformGenerationConfig(params),
  },
  top_k: {
    param: 'generationConfig',
    transform: (params: Params) => transformGenerationConfig(params),
  },
  max_tokens: {
    param: 'generationConfig',
    transform: (params: Params) => transformGenerationConfig(params),
  },
  max_completion_tokens: {
    param: 'generationConfig',
    transform: (params: Params) => transformGenerationConfig(params),
  },
  stop: {
    param: 'generationConfig',
    transform: (params: Params) => transformGenerationConfig(params),
  },
  response_format: {
    param: 'generationConfig',
    transform: (params: Params) => transformGenerationConfig(params),
  },
  logprobs: {
    param: 'generationConfig',
    transform: (params: Params) => transformGenerationConfig(params),
  },
  top_logprobs: {
    param: 'generationConfig',
    transform: (params: Params) => transformGenerationConfig(params),
  },
  // https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/configure-safety-attributes
  // Example payload to be included in the request that sets the safety settings:
  //   "safety_settings": [
  //     {
  //         "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
  //         "threshold": "BLOCK_NONE"
  //     },
  //     {
  //         "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  //         "threshold": "BLOCK_ONLY_HIGH"
  //     }
  // ]
  safety_settings: {
    param: 'safety_settings',
  },
  tools: {
    param: 'tools',
    default: '',
    transform: (params: Params) => {
      const functionDeclarations: any = [];
      const tools: any = [];
      params.tools?.forEach((tool) => {
        if (tool.type === 'function') {
          // these are not supported by google
          recursivelyDeleteUnsupportedParameters(tool.function?.parameters);
          delete tool.function?.strict;

          if (['googleSearch', 'google_search'].includes(tool.function.name)) {
            tools.push({ googleSearch: {} });
          } else if (
            ['googleSearchRetrieval', 'google_search_retrieval'].includes(
              tool.function.name
            )
          ) {
            tools.push(buildGoogleSearchRetrievalTool(tool));
          } else {
            functionDeclarations.push(tool.function);
          }
        }
      });
      if (functionDeclarations.length) {
        tools.push({ functionDeclarations });
      }
      return tools;
    },
  },
  tool_choice: {
    param: 'tool_config',
    default: '',
    transform: (params: Params) => {
      if (params.tool_choice) {
        const allowedFunctionNames: string[] = [];
        if (
          typeof params.tool_choice === 'object' &&
          params.tool_choice.type === 'function'
        ) {
          allowedFunctionNames.push(params.tool_choice.function.name);
        }
        const toolConfig: GoogleToolConfig = {
          function_calling_config: {
            mode: transformToolChoiceForGemini(params.tool_choice),
          },
        };
        if (allowedFunctionNames.length > 0) {
          toolConfig.function_calling_config.allowed_function_names =
            allowedFunctionNames;
        }
        return toolConfig;
      }
    },
  },
  labels: {
    param: 'labels',
  },
};

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: string;
    properties: Record<
      string,
      {
        type: string;
        description: string;
      }
    >;
    required: string[];
  };
}

interface AnthropicToolResultContentItem {
  type: 'tool_result';
  tool_use_id: string;
  content?: string;
}

type AnthropicMessageContentItem = AnthropicToolResultContentItem | ContentType;

interface AnthropicMessage extends Message {
  content?: string | AnthropicMessageContentItem[];
}

interface AnthorpicTextContentItem {
  type: 'text';
  text: string;
}

interface AnthropicToolContentItem {
  type: 'tool_use';
  name: string;
  id: string;
  input: Record<string, any>;
}

type AnthropicContentItem = AnthorpicTextContentItem | AnthropicToolContentItem;

const transformAssistantMessageForAnthropic = (
  msg: Message
): AnthropicMessage => {
  let content: AnthropicContentItem[] = [];
  const containsToolCalls = msg.tool_calls && msg.tool_calls.length;

  if (msg.content && typeof msg.content === 'string') {
    content.push({
      type: 'text',
      text: msg.content,
    });
  } else if (
    msg.content &&
    typeof msg.content === 'object' &&
    msg.content.length
  ) {
    if (msg.content[0].text) {
      content.push({
        type: 'text',
        text: msg.content[0].text,
      });
    }
  }
  if (containsToolCalls) {
    msg.tool_calls.forEach((toolCall: any) => {
      content.push({
        type: 'tool_use',
        name: toolCall.function.name,
        id: toolCall.id,
        input: JSON.parse(toolCall.function.arguments),
      });
    });
  }
  return {
    role: msg.role,
    content,
  };
};

const transformToolMessageForAnthropic = (msg: Message): AnthropicMessage => {
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: msg.content as string,
      },
    ],
  };
};

export const VertexAnthropicChatCompleteConfig: ProviderConfig = {
  messages: [
    {
      param: 'messages',
      required: true,
      transform: (params: Params) => {
        let messages: AnthropicMessage[] = [];
        // Transform the chat messages into a simple prompt
        if (!!params.messages) {
          params.messages.forEach((msg) => {
            if (SYSTEM_MESSAGE_ROLES.includes(msg.role)) return;

            if (msg.role === 'assistant') {
              messages.push(transformAssistantMessageForAnthropic(msg));
            } else if (
              msg.content &&
              typeof msg.content === 'object' &&
              msg.content.length
            ) {
              const transformedMessage: Record<string, any> = {
                role: msg.role,
                content: [],
              };
              msg.content.forEach((item) => {
                if (item.type === 'text') {
                  transformedMessage.content.push({
                    type: item.type,
                    text: item.text,
                  });
                } else if (
                  item.type === 'image_url' &&
                  item.image_url &&
                  item.image_url.url
                ) {
                  const parts = item.image_url.url.split(';');
                  if (parts.length === 2) {
                    const base64ImageParts = parts[1].split(',');
                    const base64Image = base64ImageParts[1];
                    const mediaTypeParts = parts[0].split(':');
                    if (mediaTypeParts.length === 2 && base64Image) {
                      const mediaType = mediaTypeParts[1];
                      transformedMessage.content.push({
                        type: 'image',
                        source: {
                          type: 'base64',
                          media_type: mediaType,
                          data: base64Image,
                        },
                      });
                    }
                  }
                }
              });
              messages.push(transformedMessage as Message);
            } else if (msg.role === 'tool') {
              // even though anthropic supports images in tool results, openai doesn't support it yet
              messages.push(transformToolMessageForAnthropic(msg));
            } else {
              messages.push({
                role: msg.role,
                content: msg.content,
              });
            }
          });
        }

        return messages;
      },
    },
    {
      param: 'system',
      required: false,
      transform: (params: Params) => {
        let systemMessage: string = '';
        // Transform the chat messages into a simple prompt
        if (!!params.messages) {
          params.messages.forEach((msg) => {
            if (
              SYSTEM_MESSAGE_ROLES.includes(msg.role) &&
              msg.content &&
              typeof msg.content === 'object' &&
              msg.content[0].text
            ) {
              systemMessage = msg.content[0].text;
            } else if (
              SYSTEM_MESSAGE_ROLES.includes(msg.role) &&
              typeof msg.content === 'string'
            ) {
              systemMessage = msg.content;
            }
          });
        }
        return systemMessage;
      },
    },
  ],
  tools: {
    param: 'tools',
    required: false,
    transform: (params: Params) => {
      let tools: AnthropicTool[] = [];
      if (params.tools) {
        params.tools.forEach((tool) => {
          if (tool.function) {
            tools.push({
              name: tool.function.name,
              description: tool.function?.description || '',
              input_schema: {
                type: tool.function.parameters?.type || 'object',
                properties: tool.function.parameters?.properties || {},
                required: tool.function.parameters?.required || [],
              },
            });
          }
        });
      }
      return tools;
    },
  },
  // None is not supported by Anthropic, defaults to auto
  tool_choice: {
    param: 'tool_choice',
    required: false,
    transform: (params: Params) => {
      if (params.tool_choice) {
        if (typeof params.tool_choice === 'string') {
          if (params.tool_choice === 'required') return { type: 'any' };
          else if (params.tool_choice === 'auto') return { type: 'auto' };
        } else if (typeof params.tool_choice === 'object') {
          return { type: 'tool', name: params.tool_choice.function.name };
        }
      }
      return null;
    },
  },
  max_tokens: {
    param: 'max_tokens',
    required: true,
  },
  max_completion_tokens: {
    param: 'max_tokens',
  },
  temperature: {
    param: 'temperature',
    default: 1,
    min: 0,
    max: 1,
  },
  top_p: {
    param: 'top_p',
    default: -1,
    min: -1,
  },
  top_k: {
    param: 'top_k',
    default: -1,
  },
  stop: {
    param: 'stop_sequences',
  },
  stream: {
    param: 'stream',
    default: false,
  },
  user: {
    param: 'metadata.user_id',
  },
  anthropic_version: {
    param: 'anthropic_version',
    required: true,
    default: 'vertex-2023-10-16',
  },
};

export const GoogleChatCompleteResponseTransform: (
  response:
    | GoogleGenerateContentResponse
    | GoogleErrorResponse
    | GoogleErrorResponse[],
  responseStatus: number,
  responseHeaders: Headers,
  strictOpenAiCompliance: boolean
) => ChatCompletionResponse | ErrorResponse = (
  response,
  responseStatus,
  _responseHeaders,
  strictOpenAiCompliance
) => {
  // when error occurs on streaming request, the response is an array of errors.
  if (
    responseStatus !== 200 &&
    Array.isArray(response) &&
    response.length > 0 &&
    'error' in response[0]
  ) {
    const { error } = response[0];

    return generateErrorResponse(
      {
        message: error.message,
        type: error.status,
        param: null,
        code: String(error.code),
      },
      GOOGLE_VERTEX_AI
    );
  }

  if (responseStatus !== 200 && 'error' in response) {
    const { error } = response;
    return generateErrorResponse(
      {
        message: error.message,
        type: error.status,
        param: null,
        code: String(error.code),
      },
      GOOGLE_VERTEX_AI
    );
  }

  if ('candidates' in response) {
    const {
      promptTokenCount = 0,
      candidatesTokenCount = 0,
      totalTokenCount = 0,
    } = response.usageMetadata;

    return {
      id: 'portkey-' + crypto.randomUUID(),
      object: 'chat_completion',
      created: Math.floor(Date.now() / 1000),
      model: response.modelVersion,
      provider: GOOGLE_VERTEX_AI,
      choices:
        response.candidates?.map((generation, index) => {
          // transform tool calls and content by iterating over the content parts
          let toolCalls: ToolCall[] = [];
          let content: string | undefined;
          for (const part of generation.content?.parts ?? []) {
            if (part.functionCall) {
              toolCalls.push({
                id: 'portkey-' + crypto.randomUUID(),
                type: 'function',
                function: {
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args),
                },
              });
            } else if (part.text) {
              // if content is already set to the chain of thought message and the user requires both the CoT message and the completion, we need to append the completion to the CoT message
              if (content?.length && !strictOpenAiCompliance) {
                content += '\r\n\r\n' + part.text;
              } else {
                // if content is already set to CoT, but user requires only the completion, we need to set content to the completion
                content = part.text;
              }
            }
          }

          const message = {
            role: MESSAGE_ROLES.ASSISTANT,
            ...(toolCalls.length && { tool_calls: toolCalls }),
            ...(content && { content }),
          };
          const logprobsContent: Logprobs[] | null =
            transformVertexLogprobs(generation);
          let logprobs;
          if (logprobsContent) {
            logprobs = {
              content: logprobsContent,
            };
          }

          return {
            message: message,
            index: index,
            finish_reason: generation.finishReason,
            logprobs,
            ...(!strictOpenAiCompliance && {
              safetyRatings: generation.safetyRatings,
            }),
            ...(!strictOpenAiCompliance && generation.groundingMetadata
              ? { groundingMetadata: generation.groundingMetadata }
              : {}),
          };
        }) ?? [],
      usage: {
        prompt_tokens: promptTokenCount,
        completion_tokens: candidatesTokenCount,
        total_tokens: totalTokenCount,
      },
    };
  }

  return generateInvalidProviderResponseError(response, GOOGLE_VERTEX_AI);
};

export const VertexLlamaChatCompleteConfig: ProviderConfig = {
  model: {
    param: 'model',
    required: true,
    default: 'meta/llama-3.1-405b-instruct-maas',
    transform: (params: Params) => {
      return (
        params.model?.replace('meta.', 'meta/') ||
        'meta/llama-3.1-405b-instruct-maas'
      );
    },
  },
  messages: {
    param: 'messages',
    required: true,
    default: [],
  },
  max_tokens: {
    param: 'max_tokens',
    default: 512,
    min: 1,
    max: 2048,
  },
  max_completion_tokens: {
    param: 'max_tokens',
    default: 512,
    min: 1,
    max: 2048,
  },
  temperature: {
    param: 'temperature',
    default: 0.5,
    min: 0,
    max: 1,
  },
  top_p: {
    param: 'top_p',
    default: 0.9,
    min: 0,
    max: 1,
  },
  top_k: {
    param: 'top_k',
    default: 0,
    min: 0,
    max: 2048,
  },
  stream: {
    param: 'stream',
    default: false,
  },
};

export const GoogleChatCompleteStreamChunkTransform: (
  response: string,
  fallbackId: string,
  streamState: any,
  strictOpenAiCompliance: boolean
) => string = (
  responseChunk,
  fallbackId,
  streamState,
  strictOpenAiCompliance
) => {
  streamState.containsChainOfThoughtMessage =
    streamState?.containsChainOfThoughtMessage ?? false;
  const chunk = responseChunk
    .trim()
    .replace(/^data: /, '')
    .trim();

  if (chunk === '[DONE]') {
    return `data: ${chunk}\n\n`;
  }

  let parsedChunk: GoogleGenerateContentResponse = JSON.parse(chunk);

  let usageMetadata;
  if (parsedChunk.usageMetadata) {
    usageMetadata = {
      prompt_tokens: parsedChunk.usageMetadata.promptTokenCount,
      completion_tokens: parsedChunk.usageMetadata.candidatesTokenCount,
      total_tokens: parsedChunk.usageMetadata.totalTokenCount,
    };
  }

  const dataChunk = {
    id: fallbackId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: parsedChunk.modelVersion,
    provider: GOOGLE_VERTEX_AI,
    choices:
      parsedChunk.candidates?.map((generation, index) => {
        let message: Message = { role: 'assistant', content: '' };
        if (generation.content?.parts[0]?.text) {
          if (generation.content.parts[0].thought)
            streamState.containsChainOfThoughtMessage = true;

          let content: string =
            strictOpenAiCompliance && streamState.containsChainOfThoughtMessage
              ? ''
              : generation.content.parts[0]?.text;
          if (generation.content.parts[1]?.text) {
            if (strictOpenAiCompliance)
              content = generation.content.parts[1].text;
            else content += '\r\n\r\n' + generation.content.parts[1]?.text;
            streamState.containsChainOfThoughtMessage = false;
          } else if (
            streamState.containsChainOfThoughtMessage &&
            !generation.content.parts[0]?.thought
          ) {
            if (strictOpenAiCompliance)
              content = generation.content.parts[0].text;
            else content = '\r\n\r\n' + content;
            streamState.containsChainOfThoughtMessage = false;
          }
          message = {
            role: 'assistant',
            content,
          };
        } else if (generation.content?.parts[0]?.functionCall) {
          message = {
            role: 'assistant',
            tool_calls: generation.content.parts.map((part, idx) => {
              if (part.functionCall) {
                return {
                  index: idx,
                  id: 'portkey-' + crypto.randomUUID(),
                  type: 'function',
                  function: {
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args),
                  },
                };
              }
            }),
          };
        }
        return {
          delta: message,
          index: index,
          finish_reason: generation.finishReason,
          ...(!strictOpenAiCompliance && {
            safetyRatings: generation.safetyRatings,
          }),
          ...(!strictOpenAiCompliance && generation.groundingMetadata
            ? { groundingMetadata: generation.groundingMetadata }
            : {}),
        };
      }) ?? [],
    ...(parsedChunk.usageMetadata?.candidatesTokenCount && {
      usage: usageMetadata,
    }),
  };

  return `data: ${JSON.stringify(dataChunk)}\n\n`;
};

export const AnthropicErrorResponseTransform: (
  response: AnthropicErrorResponse
) => ErrorResponse | undefined = (response) => {
  if ('error' in response) {
    return generateErrorResponse(
      {
        message: response.error?.message,
        type: response.error?.type,
        param: null,
        code: null,
      },
      GOOGLE_VERTEX_AI
    );
  }

  return undefined;
};

export const VertexAnthropicChatCompleteResponseTransform: (
  response: AnthropicChatCompleteResponse | AnthropicErrorResponse,
  responseStatus: number
) => ChatCompletionResponse | ErrorResponse = (response, responseStatus) => {
  if (responseStatus !== 200) {
    const errorResposne = AnthropicErrorResponseTransform(
      response as AnthropicErrorResponse
    );
    if (errorResposne) return errorResposne;
  }

  if ('content' in response) {
    const { input_tokens = 0, output_tokens = 0 } = response?.usage;

    let content = '';
    if (response.content.length && response.content[0].type === 'text') {
      content = response.content[0].text;
    }

    let toolCalls: any = [];
    response.content.forEach((item) => {
      if (item.type === 'tool_use') {
        toolCalls.push({
          id: item.id,
          type: 'function',
          function: {
            name: item.name,
            arguments: JSON.stringify(item.input),
          },
        });
      }
    });

    return {
      id: response.id,
      object: 'chat_completion',
      created: Math.floor(Date.now() / 1000),
      model: response.model,
      provider: GOOGLE_VERTEX_AI,
      choices: [
        {
          message: {
            role: 'assistant',
            content,
            tool_calls: toolCalls.length ? toolCalls : undefined,
          },
          index: 0,
          logprobs: null,
          finish_reason: response.stop_reason,
        },
      ],
      usage: {
        prompt_tokens: input_tokens,
        completion_tokens: output_tokens,
        total_tokens: input_tokens + output_tokens,
      },
    };
  }

  return generateInvalidProviderResponseError(response, GOOGLE_VERTEX_AI);
};

export const VertexAnthropicChatCompleteStreamChunkTransform: (
  response: string,
  fallbackId: string,
  streamState: Record<string, boolean>
) => string | undefined = (responseChunk, fallbackId, streamState) => {
  let chunk = responseChunk.trim();

  if (
    chunk.startsWith('event: ping') ||
    chunk.startsWith('event: content_block_stop') ||
    chunk.startsWith('event: vertex_event')
  ) {
    return;
  }

  if (chunk.startsWith('event: message_stop')) {
    return 'data: [DONE]\n\n';
  }

  chunk = chunk.replace(/^event: content_block_delta[\r\n]*/, '');
  chunk = chunk.replace(/^event: content_block_start[\r\n]*/, '');
  chunk = chunk.replace(/^event: message_delta[\r\n]*/, '');
  chunk = chunk.replace(/^event: message_start[\r\n]*/, '');
  chunk = chunk.replace(/^event: error[\r\n]*/, '');
  chunk = chunk.replace(/^data: /, '');
  chunk = chunk.trim();

  const parsedChunk: AnthropicChatCompleteStreamResponse = JSON.parse(chunk);

  if (parsedChunk.type === 'error' && parsedChunk.error) {
    return (
      `data: ${JSON.stringify({
        id: fallbackId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: '',
        provider: GOOGLE_VERTEX_AI,
        choices: [
          {
            finish_reason: parsedChunk.error.type,
            delta: {
              content: '',
            },
          },
        ],
      })}` +
      '\n\n' +
      'data: [DONE]\n\n'
    );
  }

  if (
    parsedChunk.type === 'content_block_start' &&
    parsedChunk.content_block?.type === 'text'
  ) {
    streamState.containsChainOfThoughtMessage = true;
    return;
  }

  if (parsedChunk.type === 'message_start' && parsedChunk.message?.usage) {
    return (
      `data: ${JSON.stringify({
        id: fallbackId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: '',
        provider: GOOGLE_VERTEX_AI,
        choices: [
          {
            delta: {
              content: '',
            },
            index: 0,
            logprobs: null,
            finish_reason: null,
          },
        ],
        usage: {
          prompt_tokens: parsedChunk.message?.usage?.input_tokens,
        },
      })}` + '\n\n'
    );
  }

  if (parsedChunk.type === 'message_delta' && parsedChunk.usage) {
    return (
      `data: ${JSON.stringify({
        id: fallbackId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: '',
        provider: GOOGLE_VERTEX_AI,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: parsedChunk.delta?.stop_reason,
          },
        ],
        usage: {
          completion_tokens: parsedChunk.usage?.output_tokens,
        },
      })}` + '\n\n'
    );
  }

  const toolCalls = [];
  const isToolBlockStart: boolean =
    parsedChunk.type === 'content_block_start' &&
    !!parsedChunk.content_block?.id;
  const isToolBlockDelta: boolean =
    parsedChunk.type === 'content_block_delta' &&
    !!parsedChunk.delta.partial_json;
  const toolIndex: number = streamState.containsChainOfThoughtMessage
    ? parsedChunk.index - 1
    : parsedChunk.index;

  if (isToolBlockStart && parsedChunk.content_block) {
    toolCalls.push({
      index: toolIndex,
      id: parsedChunk.content_block.id,
      type: 'function',
      function: {
        name: parsedChunk.content_block.name,
        arguments: '',
      },
    });
  } else if (isToolBlockDelta) {
    toolCalls.push({
      index: toolIndex,
      function: {
        arguments: parsedChunk.delta.partial_json,
      },
    });
  }

  return (
    `data: ${JSON.stringify({
      id: fallbackId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: '',
      provider: GOOGLE_VERTEX_AI,
      choices: [
        {
          delta: {
            content: parsedChunk.delta?.text,
            tool_calls: toolCalls.length ? toolCalls : undefined,
          },
          index: 0,
          logprobs: null,
          finish_reason: parsedChunk.delta?.stop_reason ?? null,
        },
      ],
    })}` + '\n\n'
  );
};

export const VertexLlamaChatCompleteResponseTransform: (
  response: VertexLLamaChatCompleteResponse | GoogleErrorResponse,
  responseStatus: number
) => ChatCompletionResponse | ErrorResponse = (response, responseStatus) => {
  if (
    responseStatus !== 200 &&
    Array.isArray(response) &&
    response.length > 0 &&
    'error' in response[0]
  ) {
    const { error } = response[0];

    return generateErrorResponse(
      {
        message: error.message,
        type: error.status,
        param: null,
        code: String(error.code),
      },
      GOOGLE_VERTEX_AI
    );
  }
  if ('choices' in response) {
    return {
      id: crypto.randomUUID(),
      created: Math.floor(Date.now() / 1000),
      provider: GOOGLE_VERTEX_AI,
      ...response,
    };
  }
  return generateInvalidProviderResponseError(response, GOOGLE_VERTEX_AI);
};

export const VertexLlamaChatCompleteStreamChunkTransform: (
  response: string,
  fallbackId: string
) => string = (responseChunk, fallbackId) => {
  let chunk = responseChunk.trim();
  chunk = chunk.replace(/^data: /, '');
  chunk = chunk.trim();
  const parsedChunk: VertexLlamaChatCompleteStreamChunk = JSON.parse(chunk);
  parsedChunk.id = fallbackId;
  parsedChunk.created = Math.floor(Date.now() / 1000);
  parsedChunk.provider = GOOGLE_VERTEX_AI;
  return `data: ${JSON.stringify(parsedChunk)}` + '\n\n';
};
