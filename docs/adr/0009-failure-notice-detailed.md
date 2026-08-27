# 失敗時は詳細code/messageを日本語とともに表示

dedupeはサイレント。OpenRouter 429/5xx や LLM失敗時は詳細なcode/messageを日本語の定型文とともにスレッドに表示（ephemeralではなく通常メッセージ）。429の詳細もそのまま表示しコスト/推論の透明性を優先。
