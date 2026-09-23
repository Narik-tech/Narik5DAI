"""Dependency-free sparse encoding shared by training and inference.

Piece codes and signed unmoved flags follow 5d-chess-js. Coordinates are actual
multiverse coordinates, not sequence offsets. A token budget bounds attention;
selection is deterministic and reports any discarded frontier or history.
"""

import math
from dataclasses import dataclass

ENCODING_VERSION = 1
GLOBAL_FEATURES = 32
COORDINATE_FEATURES = 7
ROYALS = {11, 12, 19, 20}


@dataclass
class EncodedPosition:
    categories: list
    coordinates: list
    global_features: list
    context: dict


def _integer(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _validate(position):
    if not isinstance(position, dict):
        raise ValueError("position must be an object")
    board = position.get("board")
    action = position.get("action")
    if not isinstance(board, list) or not 1 <= len(board) <= 257:
        raise ValueError("position.board must contain 1–257 timeline slots")
    if not _integer(action) or not 0 <= action <= 1_000_000:
        raise ValueError("position.action must be a nonnegative integer")
    boards, lines, latest = 0, 0, {}
    for line, timeline in enumerate(board):
        if timeline is None:
            continue
        if not isinstance(timeline, list) or len(timeline) > 8192:
            raise ValueError("timeline must be an array of at most 8192 half-turn slots")
        for time, squares in enumerate(timeline):
            if squares is None:
                continue
            if not isinstance(squares, list) or not 1 <= len(squares) <= 16:
                raise ValueError("board height must be between 1 and 16")
            width = len(squares[0]) if isinstance(squares[0], list) else 0
            if not 1 <= width <= 16:
                raise ValueError("board width must be between 1 and 16")
            for rank in squares:
                if not isinstance(rank, list) or len(rank) != width:
                    raise ValueError("board ranks must have equal width")
                if any(not _integer(piece) or abs(piece) > 24 for piece in rank):
                    raise ValueError("piece codes must be integers between -24 and 24")
            latest[line] = time
            boards += 1
        if line in latest:
            lines += 1
    if not boards:
        raise ValueError("position has no boards")
    promotions = position.get("promotions", [])
    if not isinstance(promotions, list) or any(not _integer(p) or not 1 <= abs(p) <= 24 for p in promotions):
        raise ValueError("promotions must be an array of piece codes")
    return board, action, promotions, latest, boards, lines


def _tokens(board, latest, even):
    # Priority: frontier board markers, frontier royals, other frontier pieces,
    # then history. All frontier tokens survive when they fit the budget.
    for line, timeline in enumerate(board):
        if line not in latest:
            continue
        coordinate = -(line + 1) / 2 if line % 2 else line / 2
        if even and coordinate > 0:
            coordinate -= 1
        for time, squares in enumerate(timeline):
            if squares is None:
                continue
            frontier = int(time == latest[line])
            common = [coordinate, time, -1, -1, latest[line] - time, len(squares), len(squares[0])]
            yield (0 if frontier else 3), [1, 0, 0, time % 2, frontier], common
            for rank, row in enumerate(squares):
                for file, piece in enumerate(row):
                    if piece:
                        coordinates = [coordinate, time, rank, file, latest[line] - time, len(squares), len(row)]
                        priority = (1 if abs(piece) in ROYALS else 2) if frontier else 3
                        yield priority, [2, abs(piece), int(piece < 0), time % 2, frontier], coordinates


def encode_position(position, max_tokens=512):
    if not _integer(max_tokens) or not 16 <= max_tokens <= 1024:
        raise ValueError("max_tokens must be between 16 and 1024")
    board, action, promotions, latest, boards, lines = _validate(position)
    # In upstream rules, an absent timeline zero marks the even-timeline variant.
    even = not isinstance(board[0], list)
    counts = [0] * 4
    for priority, _, _ in _tokens(board, latest, even):
        counts[priority] += 1
    remaining = max_tokens - 1  # CLS always survives.
    budgets = []
    for count in counts:
        take = min(count, remaining)
        budgets.append(take)
        remaining -= take
    # Even spacing across each category retains both ancient and recent history.
    selected = [set(round(i * (count - 1) / (take - 1)) for i in range(take))
                if take > 1 else ({count - 1} if take else set())
                for count, take in zip(counts, budgets)]
    categories, coordinates = [[0, 0, 0, action % 2, 0]], [[0.0] * COORDINATE_FEATURES]
    offsets = [0] * 4
    for priority, category, coordinate in _tokens(board, latest, even):
        if offsets[priority] in selected[priority]:
            categories.append(category)
            coordinates.append(coordinate)
        offsets[priority] += 1
    total = sum(counts) + 1
    global_features = [float(action % 2), math.log1p(action) / 10, math.log1p(boards) / 10,
                       math.log1p(lines) / 5, math.log1p(max(latest.values())) / 10,
                       len(categories) / total, float(even), float(sum(counts[:3]) > max_tokens - 1)]
    allowed = {abs(piece) for piece in promotions}
    global_features.extend(float(piece in allowed) for piece in range(1, 25))
    return EncodedPosition(categories, coordinates, global_features, {
        "tokens": len(categories), "totalTokens": total,
        "truncated": total > max_tokens,
        "frontierTruncated": sum(counts[:3]) > max_tokens - 1,
    })
