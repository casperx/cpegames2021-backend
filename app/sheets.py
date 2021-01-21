import os.path
import json

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

def credentials():
    creds = None

    # load existing token
    if os.path.exists('token.json'):
        with open('token.json', 'rb') as token:
            info = json.load(token)
            creds = Credentials.from_authorized_user_info(info)

    # validate token
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            # refresh token if we can
            creds.refresh(Request())
        else:
            # get new token
            flow = InstalledAppFlow.from_client_secrets_file(
                'client_secret.json',
                ['https://www.googleapis.com/auth/spreadsheets.readonly']
            )
            creds = flow.run_console()
            
        # save token for later use
        with open('token.json', 'w') as token:
            data = creds.to_json()
            data = json.loads(data)
            json.dump(data, token, indent=2)

    return creds

def sheetsService():
    creds = credentials()
    service = build('sheets', 'v4', credentials=creds)

    return service.spreadsheets()

sheetId = '17dL3LgKyNhqhpwj2ut5s_L7g168TKu6bOrlEFbfaswc'
