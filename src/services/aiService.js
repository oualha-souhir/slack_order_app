// src/aiService.js
const Order = require("../database/dbModels/Order");
const {
	postSlackMessageWithRetry,
	createSlackResponse,
} = require("../Handlers/slackApiUtils");
const { OpenAI } = require("openai");
const { getEquipeOptions } = require("./configService");

require("dotenv").config();

const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
});
// Enhanced usage example with the improved function
async function handleAICommand(
	logger,
	openai,
	Order,
	notifyUserAI,
	createSlackResponse
) {
	console.log("** handleAICommand");

	try {
		// Fetch orders with better error handling
		const orders = await Order.find({}).sort({ date: -1 }).lean(); // Use lean for better performance

		if (!orders?.length) {
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "📋 Aucune commande trouvée dans la base de données.",
			});
		}

		logger.log(`Found ${orders.length} orders, generating AI summary...`);

		// Generate summary with enhanced options
		const summaryText = await summarizeOrdersWithChat(orders, openai, logger, {
			model: "gpt-3.5-turbo",
			maxTokens: 350,
			temperature: 0.4,
		});

		logger.log(
			`Summary generated successfully: ${summaryText.substring(0, 100)}...`
		);

		// Send notification
		const notificationResult = await notifyUserAI(
			{ id_commande: "AI_SUMMARY" },
			process.env.SLACK_ADMIN_ID,
			logger,
			summaryText
		);

		logger.log(
			`Notification sent with result: ${
				notificationResult?.success ? "SUCCESS" : "FAILED"
			}`
		);

		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "✅ Résumé AI généré et envoyé dans votre DM!",
			blocks: [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `✅ *Résumé AI généré avec succès*\n📊 ${orders.length} commandes analysées\n💬 Résumé envoyé dans votre DM`,
					},
				},
			],
		});
	} catch (error) {
		logger.log(`Error in AI command processing: ${error.message}`);
		logger.log(`Error stack: ${error.stack}`);

		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "❌ Erreur lors de la génération du résumé AI. Veuillez réessayer dans quelques instants.",
			blocks: [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: "❌ *Erreur lors de la génération du résumé*\n🔄 Veuillez réessayer dans quelques instants\n📞 Contactez le support si le problème persiste",
					},
				},
			],
		});
	}
}
// caisse
async function parseRefundFromText(text, context) {
	console.log("** parseRefundFromText");
	try {
		const prompt = `
Parse the following text into a structured refund request object with these fields:
{
  "montant": "number",
  "devise": "string (XOF, USD, EUR)",
  "motif": "string",
  "date_requise": "string, in YYYY-MM-DD format"
}

The input uses labels like "montant:", "devise:", "motif:", "date requise:" followed by values. 
Extract only these fields and return a valid JSON string. 
If a field is missing, use reasonable defaults:
- devise defaults to "XOF" if not specified
- date_requise defaults to today's date if not specified
- motif is required

Input text:
"${text}"
`;

		const timeoutPromise = new Promise((_, reject) =>
			setTimeout(() => reject(new Error("Request timed out")), 2000)
		);

		const openaiPromise = openai.chat.completions.create({
			model: "gpt-3.5-turbo",
			messages: [{ role: "user", content: prompt }],
			max_tokens: 300,
			temperature: 0.5,
		});

		const response = await Promise.race([openaiPromise, timeoutPromise]);
		const rawContent = response.choices[0].message.content.trim();
		context.log(`Raw OpenAI response: ${rawContent}`);

		let result;
		try {
			result = JSON.parse(rawContent);
		} catch (parseError) {
			context.log(
				`Failed to parse OpenAI response as JSON: ${parseError.message}`
			);
			throw new Error(`Invalid JSON from OpenAI: ${rawContent}`);
		}

		// Validate currency
		if (
			result.devise &&
			!["XOF", "USD", "EUR"].includes(result.devise.toUpperCase())
		) {
			result.devise = "XOF"; // Default to XOF if invalid currency
		}

		// Ensure amount is a number
		if (typeof result.montant === "string") {
			result.montant = parseFloat(result.montant);
		}

		context.log("Parsed refund request from AI:", JSON.stringify(result));
		return result;
	} catch (error) {
		context.log(`Error parsing refund request with OpenAI: ${error.message}`);
		throw error;
	}
}
async function handleAskAI(text, requestData, context) {
	const { userId, channelId } = requestData;

	setImmediate(async () => {
		try {
			const faqResponse = await handleFrequentQuestions(text, userId, context);
			if (faqResponse.response) {
				const formattedResponse =
					typeof faqResponse.response === "string"
						? faqResponse.response
						: Object.entries(faqResponse.response)
								.map(([key, value]) => `*${key}:* ${value}`)
								.join("\n");

				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postMessage",
					{ channel: channelId, text: formattedResponse },
					process.env.SLACK_BOT_TOKEN
				);

				context.log(`FAQ response sent: ${formattedResponse}`);
			}
		} catch (error) {
			context.log(`FAQ processing error: ${error.stack}`);
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					user: userId,
					text: `Erreur: ${error.message}`,
				},
				process.env.SLACK_BOT_TOKEN
			);
		}
	});

	return createSlackResponse(200, {
		response_type: "ephemeral",
		text: "⌛ Vérification en cours... Réponse bientôt !",
	});
}

// Function to summarize orders using OpenAI chat completions

async function summarizeOrder(orders) {
	console.log("** summarizeOrder");
	const orderText = JSON.stringify(
		orders.map((order) => ({
			id_commande: order.id_commande,
			titre: order.titre,
			demandeur: order.demandeur,
			articles: order.articles,
			proformas: order.proformas,
			payments: order.payments,
			statut: order.statut,
			amountPaid: order.amountPaid,
		}))
	);
	const prompt = `Summarize the following orders into concise sentences:\n${orderText}`;
	const response = await openai.chat.completions.create({
		model: "gpt-3.5-turbo",
		messages: [{ role: "user", content: prompt }],
		max_tokens: 500,
		temperature: 0.7,
	});
	return response.choices[0].message.content.trim().split("\n");
}
async function parseOrderFromText(text, context) {
	console.log("** parseOrderFromText");
	try {
		const requiredFields = ["titre:", "equipe:", "date requise:", "articles:"];
		const missingFields = requiredFields.filter(
			(field) => !text.includes(field)
		);

		if (missingFields.length > 0) {
			const errorMessage = `Le texte fourni est incomplet. Les champs manquants sont : ${missingFields.join(
				", "
			)}`;
			context.log(errorMessage);
			throw new Error(errorMessage);
		}

		const equipeOptions = await getEquipeOptions();
		const validEquipes = equipeOptions.map((option) => option.value);

		const prompt = `
        Parse the following text into a structured order object with these fields:
        {
          "titre": "string",
          "equipe": "string, defaults to 'Non spécifié' if not provided",
          "date_requise": "string, in YYYY-MM-DD format",
          "articles": [{"quantity": "number", "unit": "string, optional", "designation": "string"}]
        }
        The input uses labels like "titre:", "equipe:", "date requise:", "articles:" followed by values. For articles, expect a quantity followed by an optional unit and "Désignation:" for the description. Extract only these fields and return a valid JSON string. Ignore "id:", "demandeur:", "canal:" as they are handled automatically. If a field is missing, use reasonable defaults or leave it undefined:
        "${text}"
      `;

		const timeoutPromise = new Promise((_, reject) =>
			setTimeout(() => reject(new Error("Request timed out")), 5000)
		);

		const openaiPromise = openai.chat.completions.create({
			model: "gpt-3.5-turbo",
			messages: [{ role: "user", content: prompt }],
			max_tokens: 300,
			temperature: 0.5,
		});

		const response = await Promise.race([openaiPromise, timeoutPromise]);
		const rawContent = response.choices[0].message.content.trim();

		context.log(`Raw OpenAI response: ${rawContent}`);
		let result;
		try {
			result = JSON.parse(rawContent);
		} catch (parseError) {
			context.log(
				`Failed to parse OpenAI response as JSON: ${parseError.message}`
			);
			throw new Error(`Invalid JSON from OpenAI: ${rawContent}`);
		}
		// Validate the equipe field
		if (result.equipe && !validEquipes.includes(result.equipe.toLowerCase())) {
			const errorMessage = `L'équipe spécifiée (${
				result.equipe
			}) n'est pas valide. Les options valides sont : ${validEquipes.join(
				", "
			)}`;
			context.log(errorMessage);
			throw new Error(errorMessage);
		}
		context.log("Parsed order from AI:", JSON.stringify(result));
		return result;
	} catch (error) {
		context.log(`Error parsing order with OpenAI: ${error.message}`);
		throw error;
	}
}

/**
 * Enhanced function to summarize orders using AI chat completion
 */
async function summarizeOrdersWithChat(orders, openai, logger, options = {}) {
	const functionName = "summarizeOrdersWithChat";
	logger.log(`** ${functionName} - Processing ${orders?.length || 0} orders`);

	// Input validation
	if (!orders || !Array.isArray(orders) || orders.length === 0) {
		logger.log(`${functionName} - No orders provided`);
		return "📋 *Résumé des Commandes*\n\n⚠️ Aucune commande à analyser.";
	}

	if (!openai) {
		logger.log(`${functionName} - OpenAI client not provided`);
		return "❌ Erreur: Client OpenAI non disponible.";
	}

	try {
		// Enhanced order data processing with more details
		const processedOrders = orders.slice(0, 50).map((order, index) => {
			const daysPending = order.date
				? Math.floor(
						(Date.now() - new Date(order.date).getTime()) /
							(1000 * 60 * 60 * 24)
				  )
				: null;

			return {
				id: order.id_commande || `ORDER_${index + 1}`,
				status: order.statut || "unknown",
				team: order.equipe.displayName || "non-assignée",
				daysPending: daysPending,
				rejection: order.rejection_reason
					? order.rejection_reason.substring(0, 100) +
					  (order.rejection_reason.length > 100 ? "..." : "")
					: null,
				missing: !order.proformas?.length ? "proforma manquant" : null,
				priority: daysPending > 7 ? "high" : daysPending > 3 ? "medium" : "low",
				amount: order.montant || null,
			};
		});

		// Generate statistics for better context
		const stats = generateOrderStats(processedOrders);

		// Create enhanced prompt
		const prompt = createAnalysisPrompt(processedOrders, stats, options);

		logger.log(
			`${functionName} - Sending request to OpenAI with ${processedOrders.length} orders`
		);

		// OpenAI API call with enhanced configuration
		const response = await openai.chat.completions.create({
			model: options.model || "gpt-3.5-turbo",
			messages: [
				{
					role: "system",
					content:
						"Tu es un assistant expert en analyse de commandes. Réponds toujours en français avec des insights pertinents et actionables.",
				},
				{
					role: "user",
					content: prompt,
				},
			],
			max_tokens: options.maxTokens || 300,
			temperature: options.temperature || 0.5,
			top_p: 0.9,
			frequency_penalty: 0.1,
			presence_penalty: 0.1,
		});

		if (!response?.choices?.[0]?.message?.content) {
			throw new Error("Invalid response from OpenAI API");
		}

		const summary = response.choices[0].message.content.trim();
		logger.log(
			`${functionName} - AI summary generated successfully (${summary.length} chars)`
		);

		// Format the final response with header and metadata
		const formattedSummary = formatSummaryResponse(
			summary,
			stats,
			processedOrders.length
		);

		return formattedSummary;
	} catch (error) {
		logger.log(`${functionName} - Error: ${error.message}`);
		logger.log(`${functionName} - Stack trace: ${error.stack}`);

		// Return user-friendly error message based on error type
		if (error.code === "rate_limit_exceeded") {
			return "⏳ Service temporairement surchargé. Veuillez réessayer dans quelques instants.";
		} else if (error.code === "invalid_api_key") {
			return "🔑 Erreur de configuration du service AI.";
		} else if (error.name === "TypeError" && error.message.includes("fetch")) {
			return "🌐 Erreur de connexion au service AI. Vérifiez votre connexion internet.";
		} else {
			return "❌ Erreur lors de la génération du résumé AI. Veuillez réessayer.";
		}
	}
}

/**
 * Generate statistics from processed orders

 */
function generateOrderStats(orders) {
	const statusCounts = {};
	const teamCounts = {};
	let totalPending = 0;
	let highPriorityCount = 0;
	let withRejections = 0;
	let missingProformas = 0;

	orders.forEach((order) => {
		// Status counts
		statusCounts[order.status] = (statusCounts[order.status] || 0) + 1;

		// Team counts
		teamCounts[order.team] = (teamCounts[order.team] || 0) + 1;

		// Other metrics
		if (order.daysPending !== null) totalPending += order.daysPending;
		if (order.priority === "high") highPriorityCount++;
		if (order.rejection) withRejections++;
		if (order.missing) missingProformas++;
	});

	return {
		total: orders.length,
		statusBreakdown: statusCounts,
		teamBreakdown: teamCounts,
		averagePendingDays: totalPending / orders.length,
		highPriorityCount,
		withRejections,
		missingProformas,
	};
}

/**
 * Create analysis prompt for OpenAI
 */

function createAnalysisPrompt(orders, stats) {
	const recentOrders = orders.slice(0, 10);

	return `Analyse ces commandes et fournis un résumé en FRANÇAIS:

STATISTIQUES GLOBALES:
- Total: ${stats.total} commandes
- Moyenne jours en attente: ${Math.round(stats.averagePendingDays)} jours
- Priorité haute: ${stats.highPriorityCount}
- Avec rejets: ${stats.withRejections}
- Proformas manquants: ${stats.missingProformas}

RÉPARTITION PAR STATUT:
${Object.entries(stats.statusBreakdown)
	.map(([status, count]) => `- ${status}: ${count}`)
	.join("\n")}

RÉPARTITION PAR ÉQUIPE:
${Object.entries(stats.teamBreakdown)
	.map(([team, count]) => `- ${team}: ${count}`)
	.join("\n")}

COMMANDES RÉCENTES (10 dernières):
${recentOrders
	.map(
		(order, i) =>
			`${i + 1}. ID: ${order.id} | Statut: ${order.status} | Équipe: ${
				order.team
			} | ${order.daysPending}j en attente${
				order.rejection ? ` | Rejet: ${order.rejection}` : ""
			}${order.missing ? ` | ${order.missing}` : ""}`
	)
	.join("\n")}

CONSIGNES:
- Identifie les tendances et problèmes principaux
- Suggère des actions prioritaires
- Utilise des emojis pour la lisibilité
- Maximum 8-10 lignes avec points clés
- Focus sur l'actionnable et les alertes importantes`;
}

/**
 * Format the final summary response
 */

function formatSummaryResponse(summary, stats, orderCount) {
	const timestamp = new Date().toLocaleString("fr-FR", {
		timeZone: "Europe/Paris",
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});

	return `📋 *Résumé Intelligence des Commandes*
🕐 Généré le ${timestamp}
📊 Analyse de ${orderCount} commandes

${summary}

💡 _Résumé généré par IA - Consultez le détail des commandes pour plus d'informations_`;
}

// Check form data for errors and suggest corrections

async function checkFormErrors(formData, orderHistory, context) {
	console.log("** checkFormErrors");
	// Extract articles (unchanged)
	const articles = Object.entries(formData)
		.filter(([key]) => key.startsWith("designation_"))
		.map(([key, value]) => {
			const articleIndex = key.split("_")[1];
			return {
				designation: value[`input_designation_${articleIndex}`]?.value || "",
				quantity: parseInt(
					formData[`quantity_number_${articleIndex}`]?.[
						`input_quantity_${articleIndex}`
					]?.value || "0"
				),
				unit:
					formData[`quantity_unit_${articleIndex}`]?.[
						`select_unit_${articleIndex}`
					]?.selected_option?.value || "piece",
			};
		});

	// Check for proforma - match the actual key
	const hasProforma = !!formData.proforma_file?.file_upload?.files?.length;

	const errors = [];
	const suggestions = {};
	// if (formData.funding_amount?.input_funding_amount?.value) {
	//     const amount = formData.funding_amount.input_funding_amount.value;
	//     if (!amount.match(/^\d+(\.\d+)?\s*(XOF|USD|EUR)$/)) {
	//       errors.push("Montant invalide. Ex: 1000 XOF");
	//       suggestions.funding_amount = "Entrez un montant valide (ex: 1000 XOF)";
	//     }
	//   } else {
	//     errors.push("Montant requis");
	//   }
	//   if (!formData.funding_reason?.input_funding_reason?.value) {
	//     errors.push("Motif requis");
	//     suggestions.funding_reason = "Entrez un motif clair (ex: Paiements fournisseurs)";
	//   }
	// Article validations
	articles.forEach((article, index) => {
		if (!article.designation || article.designation.length < 3) {
			errors.push(
				`Description pour l'article ${index + 1} est trop courte ou manquante`
			);
			suggestions[
				`designation_${index + 1}`
			] = `Veuillez fournir une description précise et détaillée`;
		}
		if (article.quantity > 500 && !hasProforma) {
			errors.push(
				`Une proforma est requise pour l'article ${index + 1} (quantité > 500)`
			);
		}
	});

	// Total quantity check

	// const totalQuantity = articles.reduce(
	// 	(sum, article) => sum + article.quantity,
	// 	0
	// );
	// if (totalQuantity > 500 && !hasProforma) {
	//   errors.push(
	//     `Une proforma est requise pour cette commande (quantité totale > 500)`
	//   );
	// }

	context.log(`Validation results: 
    Articles: ${JSON.stringify(articles)}
    Errors: ${JSON.stringify(errors)}
    Suggestions: ${JSON.stringify(suggestions)}
    Has Proforma: ${hasProforma}`);

	return { errors, suggestions, hasProforma };
}

// Suggest auto-completions based on past orders
async function suggestAutoCompletions(userId, context) {
	console.log("** suggestAutoCompletions");
	const pastOrders = Order.find({ demandeur: userId })
		.sort({ date: -1 })
		.limit(5);

	if (!pastOrders.length) return {};
	context.log(`📦 pastOrders: ${JSON.stringify(pastOrders, null, 2)}`);

	// const articles = pastOrders.flatMap((order) => order.articles);
	const prompt = `
    Analyse les commandes récentes (équipe répétée dans 'equipe') :
    ${JSON.stringify(
			pastOrders.map((o) => ({
				titre: o.titre,
				equipe: o.equipe,
				articles: o.articles,
			})),
			null,
			2
		)}
    
    Suggest auto-completion values for:
    -titre (texte le plus fréquent ou le plus récent)
    - Équipe (la plus fréquente) has to be: Maçons,Carreleur,Peintre or Coffreur
    - Quantity (most common)
    - Unit (most frequent)
    - Designation (top 3 frequent descriptions)
    Provide the response in this exact JSON format:
    {
      "titre": "valeur",

      "equipe": "value",
      "quantity": number,
      "unit": "value",
      "designations": ["value1", "value2", "value3"]
    }
  `;

	try {
		const response = await openai.chat.completions.create({
			model: "gpt-3.5-turbo",
			messages: [{ role: "user", content: prompt }],
			max_tokens: 200,
		});

		const result = response.choices[0]?.message?.content?.trim();
		context.log(`🤖 AI auto-completion result: ${result}`);

		if (!result) {
			context.log("⚠️ AI response is empty or undefined.");
			return {};
		}

		let suggestions = {};
		const equipeOptions = [
			{ text: "Maçons", value: "macons" },
			{ text: "Carreleur", value: "carreleur" },
			{ text: "Peintre", value: "peintre" },
			{ text: "Coffreur", value: "coffreur" },
		];

		try {
			// Parse JSON direct
			suggestions = JSON.parse(result);
			suggestions.titre = suggestions.titre || pastOrders[0]?.titre || "";

			// Normalisation pour le cas JSON
			if (suggestions.equipe) {
				suggestions.equipe = suggestions.equipe.toLowerCase();
			}
		} catch (jsonError) {
			context.log(
				"⚠️ AI response is not a valid JSON, trying fallback parsing...",jsonError
			);

			// Fallback text parsing
			const lines = result.split("\n").filter((line) => line.trim());
			lines.forEach((line) => {
				const match = line.match(/-\s*([^:]+):\s*(.+)/);
				if (line.includes("Titre") || line.includes("titre")) {
					suggestions.titre = line.split(":")[1]?.trim() || "";
				}
				if (match) {
					
					// eslint-disable-next-line no-unused-vars
					const [_, key, value] = match;
					const normalizedKey = key.trim().toLowerCase();

					if (
						normalizedKey.includes("équipe") ||
						normalizedKey.includes("equipe")
					) {
						suggestions.equipe = value.trim().toLowerCase();
					} else if (
						normalizedKey.includes("quantité") ||
						normalizedKey.includes("quantity")
					) {
						suggestions.quantity = parseInt(value.split(/[,\s]+/)[0]) || 1;
					} else if (
						normalizedKey.includes("unité") ||
						normalizedKey.includes("unit")
					) {
						suggestions.unit = value.trim();
					} else if (
						normalizedKey.includes("désignation") ||
						normalizedKey.includes("designation")
					) {
						suggestions.designations = value
							.split(/,\s?/)
							.map((v) => v.trim())
							.slice(0, 3);
					}
				}
			});
		}

		// Gestion dynamique des équipes après parsing
		if (
			suggestions.equipe &&
			!equipeOptions.some((opt) => opt.value === suggestions.equipe)
		) {
			equipeOptions.unshift({
				text: { type: "plain_text", text: suggestions.equipe },
				value: suggestions.equipe,
			});
		}

		context.log(
			`✅ Parsed suggestions: ${JSON.stringify(suggestions, null, 2)}`
		);
		return { ...suggestions, equipeOptions }; // Envoyer les options modifiées
	} catch (error) {
		context.log(
			`❌ AI auto-completion failed: ${error.stack || error.message}`
		);
		return {};
	}
}

// Respond to frequent questions

async function handleFrequentQuestions(text, userId, context) {
	console.log("** handleFrequentQuestions");
	const latestOrder = await Order.findOne({ demandeurId: userId }).sort({
		date: -1,
	});

	if (!latestOrder) {
		return { response: "Vous n'avez pas de commandes récentes." };
	}

	// Calculate derived information
	const totalProformas = latestOrder.proformas?.length || 0;
	const validatedProformas =
		latestOrder.proformas?.filter((p) => p.validated).length || 0;
	const totalPayments = latestOrder.payments?.length || 0;
	const lastPayment =
		latestOrder.payments?.length > 0
			? latestOrder.payments[latestOrder.payments.length - 1]
			: null;

	const prompt = `
    Analyze this user message: "${text}"
    
    Detect if it matches any of these common question categories:
    
    1. PAYMENT STATUS:
    - "Où en est mon paiement ?" / "Where is my payment?"
    - "Statut de paiement" / "Payment status"
    - Questions about payment progress
    
    2. ORDER STATUS:
    - "Statut de ma commande ?" / "Order status?"
    - "Où en est ma commande ?" / "Where is my order?"
    - Questions about order progress
    
    3. PROFORMA QUESTIONS:
    - "Mes proformas sont-ils validés ?" / "Are my proformas validated?"
    - "Combien de proformas ai-je ?" / "How many proformas do I have?"
    - Questions about proforma status
    
    4. AMOUNT/FINANCIAL QUESTIONS:
    - "Combien j'ai payé ?" / "How much have I paid?"
    - "Combien reste-t-il à payer ?" / "How much is left to pay?"
    - "Quel est le montant total ?" / "What is the total amount?"
    
    5. TIMELINE QUESTIONS:
    - "Quand ma commande sera-t-elle prête ?" / "When will my order be ready?"
    - "Date de livraison" / "Delivery date"
    - Questions about timing
    
    6. GENERAL INFO:
    - "Détails de ma commande" / "Order details"
    - "Informations sur ma commande" / "Order information"
    - Questions asking for general order information
    
    Use this order data to provide appropriate responses:
    - Order ID: ${latestOrder.id_commande}
    - Title: ${latestOrder.titre || "Non spécifié"}
    - Team: ${latestOrder.equipe.displayName || "Non spécifié"}
    - Order Status: ${latestOrder.statut || "En attente"}
    - Payment Status: ${
			latestOrder.paymentDone === "true" ? "Terminé" : "En cours"
		}
    - Total Amount: ${latestOrder.totalAmount || "Non défini"}€
    - Amount Paid: ${latestOrder.amountPaid || 0}€
    - Remaining Amount: ${latestOrder.remainingAmount || 0}€
    - Proformas: ${totalProformas} total, ${validatedProformas} validé(s)
    - Payments: ${totalPayments} paiement(s) enregistré(s)
    - Last Payment: ${
			lastPayment
				? `${lastPayment.amountPaid}€ (${
						lastPayment.paymentMode || "Mode non spécifié"
				  })`
				: "Aucun"
		}
    - Request Date: ${latestOrder.date_requete || "Non spécifiée"}
    - Creation Date: ${
			latestOrder.createdAt
				? new Date(latestOrder.createdAt).toLocaleDateString("fr-FR")
				: "Non disponible"
		}
    
    Provide a helpful, personalized response in French that directly answers their question using the relevant data above.
    
    Return JSON: { "category": "detected category", "response": "personalized response" } or { "category": null, "response": null } if no match.
  `;

	try {
		const response = await openai.chat.completions.create({
			model: "gpt-3.5-turbo",
			messages: [{ role: "user", content: prompt }],
			max_tokens: 300,
			temperature: 0.3, // Lower temperature for more consistent responses
		});

		const result = JSON.parse(response.choices[0].message.content.trim());
		context.log(`FAQ detection result: ${JSON.stringify(result)}`);

		if (result.category && result.response) {
			// Log the type of question detected for analytics
			context.log(
				`FAQ category detected: ${result.category} for user ${userId}`
			);
			return { response: result.response, category: result.category };
		}

		return { response: null };
	} catch (error) {
		context.log(`FAQ handling failed: ${error.message}`);

		// Fallback: provide basic order info if AI fails
		const fallbackResponse = `Voici les informations de votre dernière commande:
📋 Commande: ${latestOrder.id_commande}
📊 Statut: ${latestOrder.statut || "En attente"}
💰 Montant payé: ${latestOrder.amountPaid || 0}€
💳 Reste à payer: ${latestOrder.remainingAmount || 0}€`;

		return { response: fallbackResponse };
	}
}

// Helper function to get more comprehensive order info
async function getOrderSummary(userId) {
	const latestOrder = await Order.findOne({ demandeurId: userId }).sort({
		date: -1,
	});

	if (!latestOrder) {
		return null;
	}
	console.log(
		"latestOrder.proformas.montant first",
		latestOrder.proformas?.filter((p) => p.validated)[0]?.montant
	);
	console.log(
		`📦 Latest order for user ${userId}: ${JSON.stringify(
			latestOrder,
			null,
			2
		)}`
	);
	return {
		id: latestOrder.id_commande,
		title: latestOrder.titre,
		status: latestOrder.statut,

		team: latestOrder.equipe.displayName,
		totalAmount: latestOrder.proformas?.filter((p) => p.validated)[0]?.montant,
		amountPaid: latestOrder.amountPaid,
		remainingAmount: latestOrder.remainingAmount,
		paymentDone: latestOrder.paymentDone,
		proformasCount: latestOrder.proformas?.length || 0,
		validatedProformasCount:
			latestOrder.proformas?.filter((p) => p.validated).length || 0,
		paymentsCount: latestOrder.payments?.length || 0,
		requestDate: latestOrder.date_requete,
		createdAt: latestOrder.createdAt,
	};
}

module.exports = {
	summarizeOrder,
	parseOrderFromText,
	summarizeOrdersWithChat,
	checkFormErrors, // New export
	suggestAutoCompletions, // New export
	handleFrequentQuestions,
	getOrderSummary, // New export
	parseRefundFromText,
	handleAICommand,
	handleAskAI,
};
