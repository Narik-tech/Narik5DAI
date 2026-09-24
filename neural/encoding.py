"""Dependency-free sparse encoding shared by training and inference.

Piece codes and signed unmoved flags follow 5d-chess-js. Coordinates are actual
multiverse coordinates, not sequence offsets. A token budget bounds attention;
selection is deterministic and reports any discarded frontier or history.
"""

import math
from dataclasses import dataclass

ENCODING_VERSION = 1
MAX_TOKENS = 4096
GLOBAL_FEATURES = 32
COORDINATE_FEATURES = 7


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


def _timeline_coordinate(line, even):
    coordinate = -(line + 1) / 2 if line % 2 else line / 2
    return coordinate - 1 if even and coordinate > 0 else coordinate


def _select_boards(board, latest, action, even, budget):
    sizes = {(line, time): 1 + sum(piece != 0 for row in squares for piece in row)
             for line in latest for time, squares in enumerate(board[line]) if squares is not None}
    total = sum(sizes.values())
    if total <= budget:
        return set(sizes), total

    # Any mover-color frontier can be played, including future/inactive lines.
    # Completed partial turns may have no such frontier; use all latest boards.
    anchors = [(_timeline_coordinate(line, even), time)
               for line, time in latest.items() if time % 2 == action % 2]
    if not anchors:
        anchors = [(_timeline_coordinate(line, even), time) for line, time in latest.items()]

    def proximity(key):
        line, time = key
        coordinate = _timeline_coordinate(line, even)
        # A temporal movement step spans two half-turn slots.
        distance = min(abs(coordinate - anchor_line) + abs(time - anchor_time) / 2
                       for anchor_line, anchor_time in anchors)
        return distance, -time, coordinate

    selected = set()
    for key in sorted(sizes, key=proximity):
        if sizes[key] > budget:
            # Keep a nearest-first prefix: do not substitute a farther small
            # board for a closer board, or split a board into partial pieces.
            break
        selected.add(key)
        budget -= sizes[key]
    return selected, total


def _tokens(board, latest, even, selected):
    # Selection changes membership only; preserve canonical timeline/time order.
    for line, time in sorted(selected):
        squares = board[line][time]
        coordinate = _timeline_coordinate(line, even)
        frontier = int(time == latest[line])
        common = [coordinate, time, -1, -1, latest[line] - time, len(squares), len(squares[0])]
        yield [1, 0, 0, time % 2, frontier], common
        for rank, row in enumerate(squares):
            for file, piece in enumerate(row):
                if piece:
                    coordinates = [coordinate, time, rank, file, latest[line] - time, len(squares), len(row)]
                    yield [2, abs(piece), int(piece < 0), time % 2, frontier], coordinates


def encode_position(position, max_tokens=MAX_TOKENS):
    if not _integer(max_tokens) or not 16 <= max_tokens <= MAX_TOKENS:
        raise ValueError(f"max_tokens must be between 16 and {MAX_TOKENS}")
    board, action, promotions, latest, boards, lines = _validate(position)
    # In upstream rules, an absent timeline zero marks the even-timeline variant.
    even = not isinstance(board[0], list)
    selected, board_tokens = _select_boards(board, latest, action, even, max_tokens - 1)
    frontier_truncated = any((line, time) not in selected for line, time in latest.items())
    categories, coordinates = [[0, 0, 0, action % 2, 0]], [[0.0] * COORDINATE_FEATURES]
    for category, coordinate in _tokens(board, latest, even, selected):
        categories.append(category)
        coordinates.append(coordinate)
    total = board_tokens + 1
    global_features = [float(action % 2), math.log1p(action) / 10, math.log1p(boards) / 10,
                       math.log1p(lines) / 5, math.log1p(max(latest.values())) / 10,
                       len(categories) / total, float(even), float(frontier_truncated)]
    allowed = {abs(piece) for piece in promotions}
    global_features.extend(float(piece in allowed) for piece in range(1, 25))
    return EncodedPosition(categories, coordinates, global_features, {
        "tokens": len(categories), "totalTokens": total,
        "truncated": total > max_tokens,
        "frontierTruncated": frontier_truncated,
    })
