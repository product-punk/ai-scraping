import os
from openai import OpenAI

# Reads your key from the OPENAI_API_KEY environment variable.
client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])

prompt = "best supplements for better sleep"

response = client.responses.create(
    model="gpt-5",
    input=prompt,
)

print(response.output_text)
