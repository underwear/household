/** Install the mounted public Household CA into the guest's system trust before setup or agent tools run. */
export const GUEST_TRUST_SETUP = `set -e
[ -f /etc/household/ca.crt ] || exit 0
sudo -n sh -c '
  set -e
  target=/usr/local/share/ca-certificates/household.crt
  if ! cmp -s /etc/household/ca.crt "$target"; then
    install -m 644 /etc/household/ca.crt "$target"
  fi
  update-ca-certificates
'`;
