import { Buffer } from "node:buffer";
import { verifyKey } from "discord-interactions";
import type {
	DiscordAttachment,
	DiscordMessage,
	DiscordUser,
	Env,
	GeminiHistoryItem,
	GeminiPart,
	OpenRouterContent,
	OpenRouterMessage,
} from "./types";

function discordWebhookUrl(
	appId: string,
	token: string,
	suffix = "/messages/@original",
) {
	return `https://discord.com/api/v10/webhooks/${appId}/${token}${suffix}`;
}

function extractMessageContent(
	targetMsg: DiscordMessage,
	userObj: DiscordUser | undefined,
): { text: string; images: string[] } {
	const targetAuthor =
		targetMsg.author?.global_name ||
		targetMsg.author?.username ||
		"Unknown User";

	let content = targetMsg.content || "";
	if (
		!content &&
		targetMsg.message_snapshots &&
		targetMsg.message_snapshots.length > 0
	) {
		const snapshotMessage = targetMsg.message_snapshots[0].message;
		if (snapshotMessage?.content) {
			content = snapshotMessage.content;
		}
	}

	let text: string;
	if (userObj?.id && targetMsg.author?.id === userObj.id) {
		text = content;
	} else {
		text = `(引用了 ${targetAuthor} 的消息: "${content}")`;
	}

	const images: string[] = [];
	if (targetMsg.attachments && targetMsg.attachments.length > 0) {
		targetMsg.attachments.forEach((att: DiscordAttachment) => {
			if (att.content_type?.startsWith("image/")) {
				images.push(att.url);
			}
		});
	}

	return { text, images };
}

function getInteractionContext(interaction: {
	channel_id?: string;
	channel?: { id?: string };
	member?: { nick?: string; user?: DiscordUser };
	user?: DiscordUser;
}) {
	const channelId: string =
		interaction.channel_id || interaction.channel?.id || "global";
	const userObj = interaction.member?.user || interaction.user;
	const userName: string =
		interaction.member?.nick ||
		userObj?.global_name ||
		userObj?.username ||
		"Unknown";
	return { channelId, userObj, userName };
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		const signature = request.headers.get("x-signature-ed25519");
		const timestamp = request.headers.get("x-signature-timestamp");
		const body = await request.text();

		if (!signature || !timestamp || !env.DISCORD_PUBLIC_KEY) {
			return new Response("Missing headers or configuration", { status: 401 });
		}

		const isValidRequest = await verifyKey(
			body,
			signature,
			timestamp,
			env.DISCORD_PUBLIC_KEY,
		);

		if (!isValidRequest) {
			return new Response("Bad request signature", { status: 401 });
		}

		const interaction = JSON.parse(body);

		if (interaction.type === 1) {
			return Response.json({ type: 1 });
		}

		if (interaction.type === 2) {
			const commandName = interaction.data.name;
			const { channelId, userObj, userName } =
				getInteractionContext(interaction);

			if (commandName === "Quote & Ask") {
				const targetId = interaction.data.target_id;
				const messages = interaction.data.resolved?.messages;
				let quotedText = "";
				let quotedImages: string[] = [];

				if (messages?.[targetId]) {
					const extracted = extractMessageContent(messages[targetId], userObj);
					quotedText = extracted.text;
					quotedImages = extracted.images;

					if (quotedText.length > 4000) {
						quotedText = `${quotedText.substring(0, 3995)}...`;
					}
				}

				const quoteKey = `quote_${interaction.id}`;
				if (env.MEMORY_KV) {
					const quoteData = JSON.stringify({
						text: quotedText,
						images: quotedImages,
					});
					ctx.waitUntil(
						env.MEMORY_KV.put(quoteKey, quoteData, {
							expirationTtl: 300,
						}).catch(console.error),
					);
				}

				return Response.json({
					type: 9,
					data: {
						title: "引用并提问",
						custom_id: `quote_ask_modal:${quoteKey}`,
						components: [
							{
								type: 1,
								components: [
									{
										type: 4,
										custom_id: "question",
										label: "你的问题",
										style: 2,
										min_length: 1,
										max_length: 1000,
										required: true,
									},
								],
							},
						],
					},
				});
			}

			if (commandName === "ask" || commandName === "Ask Bot") {
				let prompt = "";
				let imageUrls: string[] = [];

				if (commandName === "ask") {
					const options = interaction.data.options;
					prompt =
						options?.find(
							(opt: { name: string; value: string }) => opt.name === "问题",
						)?.value || "";
					const attachmentId = options?.find(
						(opt: { name: string; value: string }) => opt.name === "图片",
					)?.value;
					if (
						attachmentId &&
						interaction.data.resolved?.attachments?.[attachmentId]
					) {
						imageUrls.push(
							interaction.data.resolved.attachments[attachmentId].url,
						);
					}
				} else if (commandName === "Ask Bot") {
					const targetId = interaction.data.target_id;
					const messages = interaction.data.resolved?.messages;
					if (messages?.[targetId]) {
						const extracted = extractMessageContent(
							messages[targetId],
							userObj,
						);
						prompt = extracted.text;
						imageUrls = extracted.images;
					}
				}

				if (prompt || imageUrls.length > 0) {
					const finalPrompt = `[用户 ${userName}]: ${prompt || "[图片]"}`;
					let displayMessage: string | undefined;
					if (commandName === "ask") {
						const parts: string[] = [];
						if (prompt) {
							parts.push(`> **提问:** ${prompt}`);
						}
						parts.push(...imageUrls);
						displayMessage = parts.join("\n");
					}
					ctx.waitUntil(
						handleAskCommand(
							finalPrompt,
							interaction.token,
							env,
							channelId,
							displayMessage,
							imageUrls,
						),
					);
				} else {
					ctx.waitUntil(
						handleAskCommand(
							`[用户 ${userName}]: 无法读取消息内容或内容为空。`,
							interaction.token,
							env,
							channelId,
						),
					);
				}

				return Response.json({ type: 5 });
			}
		}

		if (interaction.type === 5) {
			const customId = interaction.data?.custom_id;
			if (customId?.startsWith("quote_ask_modal:")) {
				const quoteKey = customId.substring("quote_ask_modal:".length);
				const { channelId, userName } = getInteractionContext(interaction);

				ctx.waitUntil(
					(async () => {
						try {
							let quotedText = "";
							let imageUrls: string[] = [];
							if (env.MEMORY_KV) {
								const rawQuote = await env.MEMORY_KV.get(quoteKey);
								if (rawQuote) {
									try {
										const parsed = JSON.parse(rawQuote);
										quotedText = parsed.text;
										imageUrls = parsed.images || [];
									} catch (_e) {
										quotedText = rawQuote;
									}
								} else {
									quotedText = "(无法获取引用的消息，可能已过期)";
								}
							} else {
								quotedText = "(KV 存储未配置，无法获取引用的消息)";
							}

							const components = interaction.data.components;
							let question = "";

							for (const row of components) {
								if (row.components) {
									for (const comp of row.components) {
										if (comp.custom_id === "question") {
											question = comp.value;
										}
									}
								}
							}

							const finalPrompt = `[用户 ${userName}]: ${question}\n\n${quotedText}`;
							const displayMessage = `> **提问:** ${question}`;
							await handleAskCommand(
								finalPrompt,
								interaction.token,
								env,
								channelId,
								displayMessage,
								imageUrls,
							);
						} catch (e) {
							console.error("Error in modal submit processing:", e);
							const errorUrl = discordWebhookUrl(
								env.DISCORD_APPLICATION_ID,
								interaction.token,
							);
							await fetch(errorUrl, {
								method: "PATCH",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({
									content: "处理引用时发生内部错误。",
								}),
							}).catch(console.error);
						}
					})(),
				);

				return Response.json({ type: 5 });
			}
		}

		return new Response("Not found", { status: 404 });
	},
};

const MAX_WORKER_TIME = 28000;
// Time kept back for sending the reply (or error) to Discord.
const DISCORD_REPLY_RESERVE_MS = 2000;
const MAX_RETRIES = 2;
const MAX_HISTORY_LENGTH = 16;

type ApiData = {
	choices?: { message?: { content?: string } }[];
	candidates?: {
		content?: { parts?: { text?: string }[] };
		finishReason?: string;
	}[];
	error?: { message?: string };
};

async function loadHistory(
	env: Env,
	historyKey: string,
): Promise<GeminiHistoryItem[]> {
	if (!env.MEMORY_KV) return [];
	const historyStr = await env.MEMORY_KV.get(historyKey);
	if (!historyStr) return [];
	try {
		return JSON.parse(historyStr);
	} catch (e) {
		console.error("Failed to parse history from KV", e);
		return [];
	}
}

// Keeps the newest strictly alternating user/model turns, starting and ending with user.
function sanitizeHistory(history: GeminiHistoryItem[]): GeminiHistoryItem[] {
	const sanitized: GeminiHistoryItem[] = [];
	let expectedRole = "user";
	for (
		let i = history.length - 1;
		i >= 0 && sanitized.length < MAX_HISTORY_LENGTH;
		i--
	) {
		const h = history[i];
		if (
			h?.role === expectedRole &&
			h.parts?.some((p: GeminiPart) => p.text?.trim() || p.inlineData)
		) {
			sanitized.unshift(h);
			expectedRole = expectedRole === "user" ? "model" : "user";
		}
	}
	if (sanitized.length > 0 && sanitized[0].role !== "user") {
		sanitized.shift();
	}
	return sanitized;
}

function buildApiRequest(
	env: Env,
	history: GeminiHistoryItem[],
	isOpenRouter: boolean,
): { url: string; headers: Record<string, string>; body: unknown } {
	if (isOpenRouter) {
		const messages: OpenRouterMessage[] = [];
		if (env.SYSTEM_PROMPT) {
			messages.push({ role: "system", content: env.SYSTEM_PROMPT });
		}
		for (const h of history) {
			const content: OpenRouterContent[] = [];
			for (const p of h.parts) {
				if (p.text) content.push({ type: "text", text: p.text });
				if (p.inlineData)
					content.push({
						type: "image_url",
						image_url: {
							url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`,
						},
					});
			}
			messages.push({
				role: h.role === "model" ? "assistant" : h.role,
				content,
			});
		}
		return {
			url: "https://openrouter.ai/api/v1/chat/completions",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
			},
			body: {
				model: env.OPENROUTER_MODEL || "",
				messages,
				max_tokens: 1500,
			},
		};
	}

	const model = env.GEMINI_MODEL || "gemini-3.1-flash";
	const body: Record<string, unknown> = {
		contents: history,
		generationConfig: {
			maxOutputTokens: 1500,
		},
	};
	if (env.SYSTEM_PROMPT) {
		body.systemInstruction = {
			parts: [{ text: env.SYSTEM_PROMPT }],
		};
	}
	return {
		url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
		headers: {
			"Content-Type": "application/json",
			"x-goog-api-key": env.GEMINI_API_KEY,
		},
		body,
	};
}

function extractReply(
	apiRes: Response,
	apiData: ApiData | undefined,
	isOpenRouter: boolean,
): { replyText: string; isError: boolean } {
	if (!apiRes.ok) {
		console.error("API Error:", JSON.stringify(apiData, null, 2));
		if (apiRes.status === 429) {
			return {
				replyText: "抱歉，服务当前请求过多被限流，请稍候重试。",
				isError: true,
			};
		}
		return {
			replyText: `抱歉，AI 服务返回了错误 (${apiRes.status})，请稍后重试。`,
			isError: true,
		};
	}

	if (isOpenRouter) {
		const replyText = apiData?.choices?.[0]?.message?.content || "";
		if (replyText) return { replyText, isError: false };
		console.error(
			"OpenRouter API Unexpected Response:",
			JSON.stringify(apiData, null, 2),
		);
		return {
			replyText: "抱歉，AI 返回了意外的响应格式，请稍后重试。",
			isError: true,
		};
	}

	let replyText = "";
	const parts = apiData?.candidates?.[0]?.content?.parts;
	if (Array.isArray(parts)) {
		replyText = parts
			.filter((part: GeminiPart) => !part.thought)
			.map((part: GeminiPart) => part.text || "")
			.join("")
			.replace(/<think>[\s\S]*?<\/think>\n*/gi, "")
			.replace(/\$\\rightarrow\$/g, "->")
			.replace(/\\rightarrow/g, "->")
			.replace(/\$\\Rightarrow\$/g, "=>")
			.replace(/\\Rightarrow/g, "=>")
			.trim();
	}
	if (replyText) return { replyText, isError: false };

	const finishReason = apiData?.candidates?.[0]?.finishReason;
	if (finishReason && finishReason !== "STOP") {
		return {
			replyText: `抱歉，内容生成被拦截。原因: ${finishReason}`,
			isError: true,
		};
	}
	console.error(
		"Gemini API Unexpected Response:",
		JSON.stringify(apiData, null, 2),
	);
	return {
		replyText: "抱歉，AI 返回了意外的响应格式，请稍后重试。",
		isError: true,
	};
}

async function sendReply(env: Env, token: string, text: string) {
	const chunks = splitMessageChunks(text, 2000);

	const patchRes = await fetch(
		discordWebhookUrl(env.DISCORD_APPLICATION_ID, token),
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: chunks[0] || "No content generated.",
			}),
		},
	);
	if (!patchRes.ok) {
		console.error(
			"Failed to update Discord message:",
			patchRes.status,
			await patchRes.text(),
		);
	}

	const followUpUrl = discordWebhookUrl(env.DISCORD_APPLICATION_ID, token, "");
	for (let i = 1; i < chunks.length; i++) {
		const postRes = await fetch(followUpUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: chunks[i],
			}),
		});
		if (!postRes.ok) {
			console.error(
				`Failed to send follow-up message ${i}:`,
				postRes.status,
				await postRes.text(),
			);
		}
	}
}

async function handleAskCommand(
	prompt: string,
	token: string,
	env: Env,
	channelId: string,
	displayMessage?: string,
	imageUrls: string[] = [],
) {
	const startTime = Date.now();
	const timeLeft = () =>
		MAX_WORKER_TIME - DISCORD_REPLY_RESERVE_MS - (Date.now() - startTime);
	try {
		const safePrompt = prompt && prompt.trim() !== "" ? prompt : "你好";
		const historyKey = `history_${channelId}`;

		const [storedHistory, images] = await Promise.all([
			loadHistory(env, historyKey),
			Promise.all(imageUrls.map(fetchImageAsBase64)),
		]);

		const userParts: GeminiPart[] = [{ text: safePrompt }];
		for (const imageData of images) {
			if (imageData) {
				userParts.push({ inlineData: imageData });
			}
		}
		storedHistory.push({ role: "user", parts: userParts });
		const history = sanitizeHistory(storedHistory);

		const isOpenRouter =
			(env.API_PROVIDER?.toUpperCase() || "OPENROUTER") === "OPENROUTER";
		const apiRequest = buildApiRequest(env, history, isOpenRouter);
		const requestBody = JSON.stringify(apiRequest.body);

		let apiRes: Response;
		let apiData: ApiData | undefined;
		for (let attempt = 0; ; attempt++) {
			const timeoutMs = timeLeft();
			if (timeoutMs <= 0) {
				throw new Error("Worker execution time limit exceeded");
			}
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
			try {
				apiRes = await fetch(apiRequest.url, {
					method: "POST",
					headers: apiRequest.headers,
					body: requestBody,
					signal: controller.signal,
				});
				const res = apiRes;
				apiData = await res.json<ApiData>().catch(() => ({
					error: { message: `Invalid JSON response: ${res.statusText}` },
				}));
			} finally {
				clearTimeout(timeoutId);
			}

			// Only 5xx is retried, and only if a retry still has a realistic time budget.
			if (apiRes.status < 500 || attempt >= MAX_RETRIES || timeLeft() < 4000) {
				break;
			}
			console.warn(
				`API returned error status ${apiRes.status}, retrying ${attempt + 1}/${MAX_RETRIES}...`,
			);
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}

		const { replyText, isError } = extractReply(apiRes, apiData, isOpenRouter);

		// Saving history runs alongside the Discord reply instead of delaying it.
		let saving: Promise<void> | undefined;
		if (!isError && env.MEMORY_KV) {
			const historyToSave = [
				...history,
				{ role: "model", parts: [{ text: replyText }] },
			].map((h) => ({
				...h,
				parts: h.parts.filter((p: GeminiPart) => !p.inlineData),
			}));
			saving = env.MEMORY_KV.put(
				historyKey,
				JSON.stringify(historyToSave),
			).catch(console.error);
		}

		await sendReply(
			env,
			token,
			displayMessage ? `${displayMessage}\n\n${replyText}` : replyText,
		);
		await saving;
	} catch (e: unknown) {
		console.error(e);
		let errorMessage = "请求 AI 服务时发生网络错误。";
		if (
			e instanceof Error &&
			(e.name === "AbortError" ||
				e.message === "Worker execution time limit exceeded")
		) {
			errorMessage = "请求超时，请稍后再试。";
		}
		const errorUrl = discordWebhookUrl(env.DISCORD_APPLICATION_ID, token);
		const patchRes = await fetch(errorUrl, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: errorMessage,
			}),
		});
		if (!patchRes.ok) {
			console.error(
				"Failed to send error message to Discord:",
				patchRes.status,
				await patchRes.text(),
			);
		}
	}
}

function splitMessageChunks(text: string, maxLength: number): string[] {
	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining);
			break;
		}

		const breakIndex = findSafeBreakPoint(remaining, maxLength);

		chunks.push(remaining.substring(0, breakIndex));
		remaining = remaining.substring(breakIndex).replace(/^\n+/, "");
	}

	return chunks;
}

function findSafeBreakPoint(text: string, maxLength: number): number {
	const candidate = text.substring(0, maxLength);
	const fenceMatches = candidate.match(/^```/gm);
	const fenceCount = fenceMatches ? fenceMatches.length : 0;
	const insideCodeBlock = fenceCount % 2 !== 0;

	if (insideCodeBlock) {
		const lastFenceIndex = candidate.lastIndexOf("\n```");
		if (lastFenceIndex > maxLength * 0.3) {
			return lastFenceIndex;
		}
	}

	let breakIndex = candidate.lastIndexOf("\n");
	if (breakIndex === -1 || breakIndex < maxLength * 0.5) {
		breakIndex = maxLength;
	}

	return breakIndex;
}

const IMAGE_FETCH_TIMEOUT_MS = 5000;

async function fetchImageAsBase64(
	url: string,
): Promise<{ mimeType: string; data: string } | null> {
	try {
		// The timeout also covers downloading the body, not just the headers.
		const response = await fetch(url, {
			signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return null;

		const arrayBuffer = await response.arrayBuffer();
		const base64 = Buffer.from(arrayBuffer).toString("base64");

		const mimeType = response.headers.get("content-type") || "image/jpeg";
		return { mimeType, data: base64 };
	} catch (e) {
		console.error("Failed to fetch image:", e);
		return null;
	}
}
