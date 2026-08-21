const { GoogleGenAI } = require("@google/genai");
const Ticket = require('../models/ticket.model');
const TechnicianModel = require('../models/technician.model');
const UserModel = require('../models/user.model');
const ai = new GoogleGenAI({});

const MODEL_NAME = 'gemini-3.1-flash-lite';

const assignTechnicianTool = {
    name: "assign_technician_and_create_ticket",
    description: "Trigger this tool ONLY AFTER diagnosing the problem AND when the user explicitly confirms (says Yes/Haan/Book kardo). DO NOT call if user says No or hasn't confirmed yet.",
    parameters: {
        type: "OBJECT",
        properties: {
            diagnosedProblem: {
                type: "STRING",
                description: "The detailed problem description after diagnosing with the user."
            },
            serviceCategory: {
                type: "STRING",
                description: "The category of service (e.g., AC and Appliance Repair, Electrical Issues, Plumbing Services, Home Cleaning)."
            }
        },
        required: ["diagnosedProblem", "serviceCategory"]
    }
};

const generateResponse = async (chatHistory, userData, userMessage, userLocation) => {
    try {
        const systemInstruction = `
        You are an intelligent, polite, and helpful customer support executive for Cosmosgen Engineering Pvt Ltd.

        CONVERSATION FLOW RULES:
        1. NO REPETITIVE GREETINGS: Do NOT say "Namaste", "Hello", or "Hi" in every message. Greet only at the very start of the conversation.
        
        2. STRICTLY NO LOCATION QUESTIONS (CRITICAL): You already have the user's exact live location, address, pincode, and landmark saved in the system database. DO NOT ask the user for their address, location, area, or pincode under any circumstances.
        
        3. PROBLEM DIAGNOSIS & CONFIRMATION:
           - Focus ONLY on understanding the user's technical problem in 1-2 brief questions.
           - Once the problem is diagnosed, explicitly ask: "Kya aap chahte hain ki main aapke liye technician book kar doon?"
           - ONLY call the tool 'assign_technician_and_create_ticket' if the user explicitly confirms (YES / Haan / Sure / Please book).
           - If the user says NO / Nahi: Acknowledge politely, cancel the process, and say "Theek hai, zaroorat padne par aap hume dobara message kar sakte hain."
           
        4. STRICT HONESTY RULE (CRITICAL): If the tool 'assign_technician_and_create_ticket' returns a status "failed", YOU MUST NOT tell the user that the ticket is booked. You must apologize and inform them that all technicians are currently busy.
        
        5. NO TECHNICAL JARGON: Never mention backend errors, database issues, or internal code details.
        
        6. TONE: Speak naturally in friendly Hinglish.
        `;

        const response = await ai.models.generateContent({
            model: MODEL_NAME,
            contents: chatHistory,
            config: {
                systemInstruction: systemInstruction,
                tools: [{ functionDeclarations: [assignTechnicianTool] }],
                temperature: 0.3
            }
        });

        const functionCall = response.functionCalls?.[0];

        if (functionCall && functionCall.name === "assign_technician_and_create_ticket") {
            const { diagnosedProblem, serviceCategory } = functionCall.args;
            console.log(`🤖 Triggering ticket for: ${serviceCategory} | ${diagnosedProblem}`);

            const userId = userData?._id || userData?.id;
            const realUser = await UserModel.findById(userId);
            let backendToolResult = {};

            if (!realUser) {
                backendToolResult = { status: "failed", message: "User profile not found." };
            } else {
                if (userLocation && userLocation.lat && userLocation.lon) {
                    realUser.lat = userLocation.lat;
                    realUser.lon = userLocation.lon;
                    if (userLocation.area) realUser.area = userLocation.area;
                    if (userLocation.state) realUser.state = userLocation.state;
                    await realUser.save();
                }

                const userState = realUser.state;
                const userArea = realUser.area || "";

                if (!userState || !userArea) {
                    backendToolResult = { status: "failed", message: "User location (State/Area) is missing." };
                } else {
                    console.log(`🔍 Searching DB Technician: State=${userState}, Area=${userArea}, Skill=${serviceCategory}`);

                    // 1. Skill ka sirf pehla main word nikal lo (e.g., "AC" ya "Plumbing")
                    const mainSkillWord = serviceCategory.trim().split(' ')[0];

                    // ==========================================
                    // 🎯 ULTRA-SMART SEARCH (Ab '&' ya 'and' se farq nahi padega)
                    // ==========================================
                    const availableTech = await TechnicianModel.findOne({
                        state: new RegExp(`^${userState.trim()}$`, 'i'), // 'i' handles Capital/Small (Odisha == odisha)
                        area: new RegExp(`^${userArea.trim()}$`, 'i'),
                        isAvailable: true,
                        skills: new RegExp(mainSkillWord, 'i') // Sirf "AC" match karega DB ke "AC & Appliance" se
                    });

                    console.log("✅ Final Tech Found:", availableTech ? availableTech.name : "STILL NULL");

                    if (availableTech) {
                        const newTicket = await Ticket.create({
                            customer: realUser._id,
                            technician: availableTech._id,
                            serviceCategory: mainSkillWord,
                            problemDescription: diagnosedProblem,
                            locationCoords: {
                                lat: realUser.lat,
                                lon: realUser.lon
                            },
                            address: realUser.area,
                            status: 'Assigned'
                        });

                        availableTech.isAvailable = false;
                        availableTech.activeTicket = newTicket._id;
                        await availableTech.save();

                        backendToolResult = {
                            status: "success",
                            message: "Technician booked successfully from database.",
                            ticketId: newTicket._id,
                            technicianDetails: {
                                name: availableTech.name,
                                phone: availableTech.phone,
                                rating: availableTech.rating,
                                eta: "15-20 minutes"
                            }
                        };
                    } else {
                        console.log(`❌ No active technician found in ${userArea}, ${userState}`);
                        backendToolResult = {
                            status: "failed",
                            message: `No active technician available right now in ${userArea}, ${userState}.`
                        };
                    }
                }
            }

            chatHistory.push(response.candidates[0].content);
            chatHistory.push({
                role: "user",
                parts: [{
                    functionResponse: {
                        name: functionCall.name,
                        response: backendToolResult
                    }
                }]
            });

            const finalResponse = await ai.models.generateContent({
                model: MODEL_NAME,
                contents: chatHistory,
                config: {
                    systemInstruction: systemInstruction,
                    tools: [{ functionDeclarations: [assignTechnicianTool] }],
                    temperature: 0.4
                }
            });

            let finalText = finalResponse.text;
            if (backendToolResult.status === "success") {
                finalText += "\n[SHOW_MAP]";
            }

            return finalText;
        }
        return response.text;
    } catch (error) {
        console.error("🚨 AI Processing Error Handled:", error);
        return "Maaf kijiyega, kuch server problem ke karan main process nahi kar paya. Kripya thodi der baad try karein.";
    }
};
async function generateVector(content) {
    if (!content || (typeof content === 'string' && !content.trim())) {
        return [];
    }

    const response = await ai.models.embedContent({
        model: "gemini-embedding-001",
        contents: content,
        config: {
            outputDimensionality: 768
        }
    })

    const values = response?.embeddings?.[0]?.values;
    return Array.isArray(values) ? values : [];
}

module.exports = {
    generateResponse,
    generateVector
}