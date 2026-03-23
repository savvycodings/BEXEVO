import { GoogleGenerativeAI } from "@google/generative-ai"

import { Request, Response } from "express"

export async function gemini(req: Request, res: Response) {
  console.log('[Chat] Gemini request received', { hasPrompt: !!req.body?.prompt, bodyKeys: Object.keys(req.body || {}) })
  try {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache'
    })
    const { prompt } = req.body
    if (!prompt) {
      console.log('[Chat] Gemini: no prompt in body')
      return res.json({
        error: 'no prompt'
      })
    }

    console.log('[Chat] Gemini calling API, prompt length:', prompt?.length)
    const genAIInit = new GoogleGenerativeAI(`${process.env.GEMINI_API_KEY}`)

    const model = genAIInit.getGenerativeModel({
      model: "gemini-3-pro-preview",
    })

    const geminiResult = await model.generateContentStream(prompt)

    if (geminiResult && geminiResult.stream) {
        await streamToStdout(geminiResult.stream, res)
      } else {
        res.end()
      }

    } catch (err) {
      console.error('[Chat] Gemini error:', err)
      res.write('data: [DONE]\n\n')
      res.end()
    }
}

export async function streamToStdout(stream :any, res: Response) {
  for await (const chunk of stream) {
    const chunkText = chunk.text()
    res.write(`data: ${JSON.stringify(chunkText)}\n\n`)
  }
  res.write('data: [DONE]\n\n')
  res.end()
}
