# CareerMitra — AI-enabled Vercel deployment

This version uses a same-origin `/api/ai` Vercel serverless function. The browser never receives the OpenAI API key.

## Vercel setup

1. Upload/push this folder as the project root.
2. In Vercel: Project Settings → Environment Variables.
3. Add:
   - Name: `OPENAI_API_KEY`
   - Value: your OpenAI API key
   - Environments: Production + Preview (and Development if needed)
4. Optional:
   - Name: `OPENAI_MODEL`
   - Value: `gpt-6-luna`
5. Redeploy after adding/changing environment variables.

The Test Zone calls `/api/ai`. If the AI service fails, the existing built-in vault-based generator remains available as a fallback.
