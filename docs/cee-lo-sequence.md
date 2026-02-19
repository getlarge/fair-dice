# Cee-Lo MQTT/WS North Star (Sequence)

```mermaid
sequenceDiagram
    participant Host
    participant Broker as MQTT/WS Broker
    participant P1 as Player 1 (shell)
    participant P2 as Player 2 (shell)

    Host->>Broker: RETAIN cee-lo/lobbies {game_id, host_fp, beacon_source, min_players}
    Note right of Broker: Retained lobby delivered to new subscribers

    P1->>Broker: SUB cee-lo/lobbies
    Broker-->>P1: Lobby announcement
    P1->>P1: Wait for user join command

    P2->>Broker: SUB cee-lo/lobbies
    Broker-->>P2: Lobby announcement
    P2->>P2: Wait for user join command

    P1->>Broker: PUB cee-lo/game/joins {commit,pubkey,sig}
    Broker-->>Host: Forward join
    Host->>Host: Verify sig + allowlist, store join

    P2->>Broker: PUB cee-lo/game/joins {commit,pubkey,sig}
    Broker-->>Host: Forward join
    Host->>Host: Verify sig + allowlist, store join

    Host->>Broker: PUB cee-lo/game/reveals/ask
    Broker-->>P1: Reveal request
    Broker-->>P2: Reveal request

    P1->>Broker: PUB cee-lo/game/reveals {seed,sig}
    P2->>Broker: PUB cee-lo/game/reveals {seed,sig}
    Broker-->>Host: Forward reveals
    Host->>Host: Check seed vs commit

    Host->>Host: HKDF(seeds+host_salt+beacon) to dice
    Host->>Host: Evaluate dice (4-5-6/triples/point/1-2-3/non-scoring)
    Host->>Host: Sign proof JSON with host key
    Host->>Broker: PUB cee-lo/game/proofs {proof,signature}
    Broker-->>P1: Proof (dice, seeds, signature)
    Broker-->>P2: Proof

    P1->>P1: Verify proof (commits, HKDF, signature)
    P2->>P2: Verify proof
```

## CLI Shell UX (planned)
- `fair-dice ceelo shell --mqtt ws://localhost:8080` starts an interactive shell:
  - Subscribes to `cee-lo/lobbies` and `cee-lo/<game>/proofs`.
  - Shows lobby list; user can `join <game> [--hand h]`.
  - Generates/loads key; sends commit; on reveal request auto-reveals (or manual `reveal`).
  - Displays live events: joins, reveal asks, proofs, dice results.

## Topics (stable)
- `cee-lo/lobbies` (retained): lobby announcements.
- `cee-lo/<game>/joins`: signed commits.
- `cee-lo/<game>/reveals`: signed seeds.
- `cee-lo/<game>/reveals/ask`: host prompt to reveal now.
- `cee-lo/<game>/proofs`: signed proof bundle (dice, seeds, salt, beacon, signature).
- Optional `cee-lo/<game>/acks`: host feedback (join accepted/rejected).
