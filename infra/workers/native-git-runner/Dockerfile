FROM docker.io/cloudflare/sandbox:0.12.4

USER root

ARG TARGETARCH
ARG NANOCODEX_VERSION=0.3.0
ARG NANOCODEX_AMD64_SHA256=0647bb658477cb66bea8b4b5b39d0e9ef9c897d7951f487da60dc83a3d626267
ARG GH_VERSION=2.97.0
ARG GH_AMD64_SHA256=a2c9b8497e1f85b1ad0dfcb78b5a622e098801b8e461e459e88e1ee12f018112
ARG GH_STACK_VERSION=0.1.0
ARG GH_STACK_AMD64_SHA256=358552dd7dce0a46ce153fe196270cec482b84f080947890aad4061a8d44bc0b

# Production currently uses the Sandbox lite x86_64 runtime. Every downloaded
# executable is release-pinned and digest-verified; no credential is baked in.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates coreutils curl tar \
    && test "$TARGETARCH" = "amd64" \
    && curl --fail --location --retry 3 "https://github.com/gakonst/nanocodex/releases/download/v${NANOCODEX_VERSION}/nanocodex-x86_64-unknown-linux-gnu" --output /tmp/nanocodex \
    && echo "${NANOCODEX_AMD64_SHA256}  /tmp/nanocodex" | sha256sum --check \
    && install -m 0755 /tmp/nanocodex /usr/local/bin/nanocodex \
    && curl --fail --location --retry 3 "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" --output /tmp/gh.tar.gz \
    && echo "${GH_AMD64_SHA256}  /tmp/gh.tar.gz" | sha256sum --check \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
    && mkdir -p /root/.local/share/gh/extensions/gh-stack \
    && curl --fail --location --retry 3 "https://github.com/github/gh-stack/releases/download/v${GH_STACK_VERSION}/linux-amd64" --output /tmp/gh-stack \
    && echo "${GH_STACK_AMD64_SHA256}  /tmp/gh-stack" | sha256sum --check \
    && install -m 0755 /tmp/gh-stack /root/.local/share/gh/extensions/gh-stack/gh-stack

COPY agent-entrypoint.mjs /opt/app-harness/agent-entrypoint.mjs

EXPOSE 8080
