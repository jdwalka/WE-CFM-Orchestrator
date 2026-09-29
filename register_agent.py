import os
# pyrefly: ignore [missing-import]
from dotenv import load_dotenv
# pyrefly: ignore [missing-import]
from uagents_core.utils.registration import (
    register_chat_agent,
    RegistrationRequestCredentials,
)

# Load environment variables from the .env file in the same directory
script_dir = os.path.dirname(os.path.abspath(__file__))
env_path = os.path.join(script_dir, ".env")
load_dotenv(dotenv_path=env_path)

def main():
    try:
        agentverse_key = os.environ["AGENTVERSE_KEY"]
        seed_phrase = os.environ["AGENT_SEED_PHRASE"]
        
        print("Registering chat agent...")
        register_chat_agent(
            "Albie",
            "https://prairiedog-godzilla.ts.net",
            active=True,
            credentials=RegistrationRequestCredentials(
                agentverse_api_key=agentverse_key,
                agent_seed_phrase=seed_phrase,        
            ),
        )
        print("Agent 'Albie' registered successfully!")
    except KeyError as e:
        print(f"Missing required environment variable: {e}")
    except Exception as e:
        print(f"An error occurred during registration: {e}")

if __name__ == "__main__":
    main()
