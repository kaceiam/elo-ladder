# Chess.com-style Elo rating system
# Standalone: no dependencies, run with `python elo.py`

MIN_ELO = 0
MAX_ELO = 30000

# (minimum elo, rank name), highest first — add tiers here
RANKS = [
    (2500, "Grandmaster"),
    (2000, "Master"),
    (1500, "Advanced"),
    (1000, "Intermediate"),
    (0, "Beginner"),
]

# New players move fast, established and top players move slower
PROVISIONAL_GAMES = 30
K_PROVISIONAL = 40
K_ESTABLISHED = 20
K_TOP = 10
TOP_ELO = 2400


class Player:
    def __init__(self, name, elo=1200, games_played=0):
        self.name = name
        self.elo = elo
        self.games_played = games_played

    @property
    def rank(self):
        for threshold, name in RANKS:
            if self.elo >= threshold:
                return name
        return RANKS[-1][1]

    @property
    def k_factor(self):
        if self.games_played < PROVISIONAL_GAMES:
            return K_PROVISIONAL
        if self.elo >= TOP_ELO:
            return K_TOP
        return K_ESTABLISHED

    def __repr__(self):
        return f"{self.name}: {round(self.elo)} ({self.rank}, {self.games_played} games)"


def expected_score(player_elo, opponent_elo):
    return 1 / (1 + 10 ** ((opponent_elo - player_elo) / 400))


def record_match(player_a, player_b, result):
    """
    Update both players' ratings after one game.

    result is from player_a's point of view:
        1   = A wins
        0.5 = draw
        0   = A loses

    Returns (change_a, change_b).
    """
    if result not in (0, 0.5, 1):
        raise ValueError("result must be 1, 0.5 or 0")

    # Use pre-match ratings for both sides
    exp_a = expected_score(player_a.elo, player_b.elo)
    exp_b = 1 - exp_a
    change_a = player_a.k_factor * (result - exp_a)
    change_b = player_b.k_factor * ((1 - result) - exp_b)

    for player, change in ((player_a, change_a), (player_b, change_b)):
        player.elo = max(MIN_ELO, min(player.elo + change, MAX_ELO))
        player.games_played += 1

    return change_a, change_b


if __name__ == "__main__":
    kyle = Player("Kyle", elo=800)
    bot = Player("Grandmaster Bot", elo=2500, games_played=500)

    gain, loss = record_match(kyle, bot, result=1)  # Kyle wins

    print(f"Kyle: {gain:+.2f}  ->  {kyle}")
    print(f"Bot:  {loss:+.2f}  ->  {bot}")
