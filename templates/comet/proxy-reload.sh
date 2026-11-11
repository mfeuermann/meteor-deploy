if ! OUT=$(sudo docker exec mup-nginx-proxy nginx -t 2>&1); then
  >&2 echo "$OUT"
  >&2 echo "nginx rejected the new configuration; it keeps serving the previous one."
  exit 1
fi
sudo docker exec mup-nginx-proxy nginx -s reload
