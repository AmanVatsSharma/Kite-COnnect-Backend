#!/bin/bash

# Client API Key Management Script
# Usage: ./manage-clients.sh create|list|deactivate|status

ADMIN_TOKEN="your-secure-admin-token-here"
BASE_URL="http://localhost:3000"

case "$1" in
  "create")
    CLIENT_ID="$2"
    CLIENT_NAME="$3"
    RATE_LIMIT="${4:-1000}"
    CONNECTION_LIMIT="${5:-100}"
    
    curl -X POST "$BASE_URL/api/admin/apikeys" \
      -H "Content-Type: application/json" \
      -H "x-admin-token: $ADMIN_TOKEN" \
      -d "{
        \"key\": \"client-prod-$CLIENT_ID\", 
        \"tenant_id\": \"client-$CLIENT_ID\", 
        \"name\": \"$CLIENT_NAME\", 
        \"rate_limit_per_minute\": $RATE_LIMIT, 
        \"connection_limit\": $CONNECTION_LIMIT
      }"
    ;;
    
  "list")
    curl -X GET "$BASE_URL/api/admin/apikeys" \
      -H "x-admin-token: $ADMIN_TOKEN"
    ;;
    
  "deactivate")
    API_KEY="$2"
    curl -X POST "$BASE_URL/api/admin/apikeys/deactivate" \
      -H "Content-Type: application/json" \
      -H "x-admin-token: $ADMIN_TOKEN" \
      -d "{\"key\": \"$API_KEY\"}"
    ;;
    
  "status")
    curl -X GET "$BASE_URL/api/admin/stream/status" \
      -H "x-admin-token: $ADMIN_TOKEN"
    ;;
    
  *)
    echo "Usage: $0 {create|list|deactivate|status}"
    echo "Examples:"
    echo "  $0 create 001 'Trading Firm A' 2000 200"
    echo "  $0 list"
    echo "  $0 deactivate client-prod-001"
    echo "  $0 status"
    ;;
esac
