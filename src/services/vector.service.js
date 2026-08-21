const { Pinecone } = require('@pinecone-database/pinecone')

const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const cosmosgen_Index = pc.index('cosmosgen-chat'); // Aapka naya index name

async function createMemory({ vectors, metadata={}, messageId }) {
    if (!vectors || vectors.length === 0) return; 

    // 👉 FIX 1 & 2: { records: [...] } format use kiya aur metadata proper object mein rakha
    await cosmosgen_Index.upsert({
        records: [
            {
                id: messageId.toString(), 
                values: vectors,
                metadata: metadata 
            }
        ]
    })
}

const queryMemory = async ({ queryVector, limit = 5, metadata }) => {
    if (!queryVector || queryVector.length === 0) return [];

    const data = await cosmosgen_Index.query({
        vector: queryVector,
        topK: limit,
        filter: metadata ? metadata : undefined,
        includeMetadata: true
    })
    return data.matches;
}

module.exports = {
    createMemory,
    queryMemory
}