package navview;

import java.util.Collections;
import java.util.List;

final class PathSnapshot {
    final boolean active;
    final String status;
    final int cursor;
    final double[] goal;
    final double[] bot;
    final List<Node> nodes;

    PathSnapshot (boolean active, String status, int cursor, double[] goal, double[] bot, List<Node> nodes) {
        this.active = active;
        this.status = status;
        this.cursor = cursor;
        this.goal = goal;
        this.bot = bot;
        this.nodes = nodes;
    }

    static final PathSnapshot EMPTY = new PathSnapshot(false, "idle", 0, null, null, Collections.<Node>emptyList());

    static final class Node {
        final int index;
        final double x;
        final double y;
        final double z;
        final String kind;
        final boolean anchor;

        Node (int index, double x, double y, double z, String kind, boolean anchor) {
            this.index = index;
            this.x = x;
            this.y = y;
            this.z = z;
            this.kind = kind;
            this.anchor = anchor;
        }
    }
}
