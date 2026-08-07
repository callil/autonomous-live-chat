FROM docker.io/cloudflare/sandbox:0.12.4

USER root

ARG TARGETARCH
ARG GH_VERSION=2.97.0
ARG GH_AMD64_SHA256=a2c9b8497e1f85b1ad0dfcb78b5a622e098801b8e461e459e88e1ee12f018112
ARG GH_STACK_VERSION=0.1.0
ARG GH_STACK_AMD64_SHA256=358552dd7dce0a46ce153fe196270cec482b84f080947890aad4061a8d44bc0b

# Production currently uses the Sandbox lite x86_64 runtime. Every downloaded
# executable is release-pinned and digest-verified; no credential is baked in.
# The coding agent is a direct OpenAI Responses API loop in agent-entrypoint.mjs
# on the base image's Node runtime — no agent binary is installed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates coreutils curl tar \
    && test "$TARGETARCH" = "amd64" \
    && curl --fail --location --retry 3 "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" --output /tmp/gh.tar.gz \
    && echo "${GH_AMD64_SHA256}  /tmp/gh.tar.gz" | sha256sum --check \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
    && mkdir -p /root/.local/share/gh/extensions/gh-stack \
    && curl --fail --location --retry 3 "https://github.com/github/gh-stack/releases/download/v${GH_STACK_VERSION}/linux-amd64" --output /tmp/gh-stack \
    && echo "${GH_STACK_AMD64_SHA256}  /tmp/gh-stack" | sha256sum --check \
    && install -m 0755 /tmp/gh-stack /root/.local/share/gh/extensions/gh-stack/gh-stack

COPY agent-entrypoint.mjs job-entrypoint.mjs /opt/app-harness/

EXPOSE 8080
