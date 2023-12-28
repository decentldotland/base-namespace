export async function handle(state, action) {
  const input = action.input;

  if (input.function === "mint") {
    const { caller, sig, domain, tx_fee } = input;

    _notPaused();

    const encodedMessage = btoa(`${state.sig_message}${state.counter}`);
    await _moleculeSignatureVerification(caller, encodedMessage, sig);

    const normalized_domain = _validateDomain(domain);
    const normalized_caller = caller.toLowerCase();
    const caller_index = state.domains.findIndex(
      (domain) => domain.owner === normalized_caller,
    );
    await _validatePayment(normalized_domain, tx_fee, caller);

    // assign primary domain
    if (caller_index === -1) {
      state.domains.push({
        owner: normalized_caller,
        domain: normalized_domain,
        is_primary: true,
      });
      // assign primary domain for reverse resolving via KVS
      SmartWeave.kv.put(`user_${normalized_domain}`, normalized_caller);
      SmartWeave.kv.put(normalized_caller, `user_${normalized_domain}`);

      return { state };
    }

    state.domains.push({
      owner: normalized_caller,
      domain: normalized_domain,
      is_primary: false,
    });

    return { state };
  }

  if (input.function === "setPrimaryDomain") {
    const { caller, sig, domain } = input;

    _notPaused();

    const normalized_domain = _handleDomainSyntax(domain);
    const normalized_caller = caller.toLowerCase();
    const domain_index = state.domains.findIndex(
      (user) =>
        user.domain === normalized_domain && user.owner === normalized_caller,
    );
    const old_domain_index = state.domains.findIndex(
      (user) => user.is_primary && user.owner === normalized_caller,
    );
    ContractAssert(domain_index !== -1, "ERROR_UNAUTHORIZED_CALLER");

    const encodedMessage = btoa(`${state.sig_message}${state.counter}`);
    await _moleculeSignatureVerification(caller, encodedMessage, sig);

    SmartWeave.kv.put(`user_${normalized_domain}`, normalized_caller);
    SmartWeave.kv.put(normalized_caller, `user_${normalized_domain}`);
    state.domains[domain_index].is_primary = true;

    if (old_domain_index !== -1) {
      state.domains[old_domain_index].is_primary = false;
    }

    return { state };
  }

  if (input.function === "transfer") {
    const { caller, sig, domain, target } = input;

    _notPaused();

    const normalized_domain = _handleDomainSyntax(domain);
    const normalized_caller = caller.toLowerCase();
    _validateEoaSyntax(target);
    const normalized_target = target.toLowerCase();

    const domainIndex = state.domains.findIndex(
      (user) =>
        user.domain === normalized_domain && user.owner === normalized_caller,
    );
    ContractAssert(domainIndex !== -1, "ERROR_DOMAIN_NOT_FOUND");

    const encodedMessage = btoa(`${state.sig_message}${state.counter}`);
    await _moleculeSignatureVerification(caller, encodedMessage, sig);

    if (state.domains[domainIndex].is_primary) {
      SmartWeave.kv.del(`user_${normalized_domain}`);
      SmartWeave.kv.del(normalized_caller);
      state.domains[domainIndex].is_primary = false;
    }

    state.domains[domainIndex].owner = normalized_target;

    return { state };
  }

  if (input.function === "resolve") {
    const { domain, address } = input;

    if (domain) {
      const normalized_domain = _handleDomainSyntax(domain);
      const res = SmartWeave.kv.get(normalized_domain);
      return { result: res };
    }

    const res = SmartWeave.kv.get(address.toLowerCase());
    return { result: res };
  }

  // ADMIN FUNCTIONS

  if (input.function === "pauseUnpauseContract") {
    const { sig } = input;

    const encodedMessage = btoa(`${state.sig_message}${state.counter}`);
    await _moleculeSignatureVerification(
      state.admin_address,
      encodedMessage,
      sig,
    );

    const status = state.isPaused;
    state.isPaused = !status;

    return { state };
  }

  function _notPaused() {
    ContractAssert(!state.isPaused, "ERROR_CONTRACT_PAUSED");
  }

  function _validateDomain(domain) {
    const normalized = domain.trim().toLowerCase().normalize("NFKC");
    ContractAssert(
      /^[a-z0-9]+$/.test(normalized),
      "ERROR_INVALID_DOMAIN_SYNTAX",
    );
    ContractAssert(
      !state.domains.map((user) => user.domain).includes(normalized),
      "ERROR_DOMAIN_MINTED",
    );
    return normalized;
  }

  function _handleDomainSyntax(domain) {
    const normalized = domain.trim().toLowerCase().normalize("NFKC");
    ContractAssert(
      /^[a-z0-9]+$/.test(normalized),
      "ERROR_INVALID_DOMAIN_SYNTAX",
    );
    return normalized;
  }

  function _validateEoaSyntax(address) {
    ContractAssert(
      /^(0x)?[0-9a-fA-F]{40}$/.test(address),
      "ERROR_INVALID_EOA_ADDR",
    );
  }

  async function _moleculeSignatureVerification(caller, message, signature) {
    try {
      ContractAssert(
        !state.signatures.includes(signature),
        "ERROR_SIGNATURE_ALREADY_USED",
      );

      const isValid = await EXM.deterministicFetch(
        `${state.evm_molecule_endpoint}/signer/${caller}/${message}/${signature}`,
      );
      ContractAssert(isValid.asJSON()?.result, "ERROR_UNAUTHORIZED_CALLER");
      state.signatures.push(signature);
      state.counter += 1;
    } catch (error) {
      throw new ContractError("ERROR_MOLECULE.SH_CONNECTION");
    }
  }

  function _getDomainType(domain) {
    return `l${domain.length}`;
  }

  async function _validatePayment(domain, txid, from) {
    try {
      ContractAssert(!state.payments.includes(txid), "ERROR_DOUBLE_SPENDING");

      const domainType = _getDomainType(domain);
      const cost = state.pricing[domainType];
      const req = await EXM.deterministicFetch(
        `${state.payments_molecule_endpoint}/${state.chain}/${from}/${txid}`,
      );
      const tx = req.asJSON();
      ContractAssert(
        tx?.address == state.token_address &&
          !!Number(tx?.value) &&
          tx?.to_address.toLowerCase() == state.treasury_address.toLowerCase() &&
          tx?.from_address.toLowerCase() === from.toLowerCase(),
        "ERROR_INVALID_AR_PRICE",
      );

      ContractAssert(
        Number(tx?.value) >= cost,
        "ERROR_UNDERPAID",
      );

      state.payments.push(txid);
    } catch (error) {
      throw new ContractError("ERROR_MOLECULE_SERVER_ERROR");
    }
  }
}