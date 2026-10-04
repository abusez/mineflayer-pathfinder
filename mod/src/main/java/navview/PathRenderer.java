package navview;

import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.GlStateManager;
import net.minecraft.client.renderer.Tessellator;
import net.minecraft.client.renderer.WorldRenderer;
import net.minecraft.client.renderer.vertex.DefaultVertexFormats;
import net.minecraft.entity.Entity;
import net.minecraftforge.client.event.RenderWorldLastEvent;
import net.minecraftforge.fml.common.eventhandler.SubscribeEvent;
import org.lwjgl.opengl.GL11;

import java.util.ArrayList;
import java.util.List;

// World overlay. Nodes sit on the floor; the path joins them, arcing over jumps.
final class PathRenderer {
    private static final float LIFT = 0.05F;

    @SubscribeEvent
    public void onRender (RenderWorldLastEvent event) {
        if (!NavView.enabled) return;
        PathSnapshot snap = PathClient.current();
        if (snap == null) return;
        if (snap.nodes.isEmpty() && snap.goal == null && !(snap.bot != null && snap.active)) return;

        Minecraft mc = Minecraft.getMinecraft();
        Entity view = mc.getRenderViewEntity();
        if (view == null) return;
        float partial = event.partialTicks;
        double cx = view.lastTickPosX + (view.posX - view.lastTickPosX) * partial;
        double cy = view.lastTickPosY + (view.posY - view.lastTickPosY) * partial;
        double cz = view.lastTickPosZ + (view.posZ - view.lastTickPosZ) * partial;

        GlStateManager.pushMatrix();
        GlStateManager.translate(-cx, -cy, -cz);
        GlStateManager.disableTexture2D();
        GlStateManager.disableLighting();
        GlStateManager.enableBlend();
        GlStateManager.tryBlendFuncSeparate(770, 771, 1, 0);
        GlStateManager.disableCull();
        GlStateManager.enableDepth();
        GlStateManager.depthMask(false);
        GL11.glLineWidth(2.0F);
        try {
            draw(snap);
        } finally {
            GL11.glLineWidth(1.0F);
            GlStateManager.depthMask(true);
            GlStateManager.enableCull();
            GlStateManager.enableTexture2D();
            GlStateManager.enableLighting();
            GlStateManager.disableBlend();
            GlStateManager.color(1F, 1F, 1F, 1F);
            GlStateManager.popMatrix();
        }
    }

    private void draw (PathSnapshot snap) {
        List<PathSnapshot.Node> nodes = snap.nodes;
        int cursor = snap.cursor;
        Tessellator tess = Tessellator.getInstance();
        WorldRenderer buffer = tess.getWorldRenderer();

        if (nodes.size() >= 2) {
            List<Vert> line = new ArrayList<Vert>();
            for (int i = 0; i < nodes.size() - 1; i++) {
                PathSnapshot.Node a = nodes.get(i);
                PathSnapshot.Node b = nodes.get(i + 1);
                int[] color = colorFor(b.kind);
                int alpha = segmentAlpha(i, cursor);
                if (i == 0) line.add(new Vert(a.x, a.y + LIFT, a.z, colorFor(a.kind), alpha));
                if (arcs(b.kind, a, b)) {
                    int steps = 8;
                    double lift = b.kind.equals("drop") ? 0.12 : Math.min(1.15, 0.18 * Math.hypot(b.x - a.x, b.z - a.z));
                    for (int s = 1; s <= steps; s++) {
                        double t = s / (double) steps;
                        double h = 4 * t * (1 - t);
                        line.add(new Vert(
                            a.x + (b.x - a.x) * t,
                            a.y + (b.y - a.y) * t + lift * h + LIFT,
                            a.z + (b.z - a.z) * t,
                            color,
                            alpha
                        ));
                    }
                } else {
                    line.add(new Vert(b.x, b.y + LIFT, b.z, color, alpha));
                }
            }
            buffer.begin(GL11.GL_LINE_STRIP, DefaultVertexFormats.POSITION_COLOR);
            for (Vert v : line) buffer.pos(v.x, v.y, v.z).color(v.r, v.g, v.b, v.a).endVertex();
            tess.draw();
        }

        for (PathSnapshot.Node node : nodes) {
            int[] color = colorFor(node.kind);
            boolean current = node.index == cursor;
            int alpha = node.index < cursor ? 70 : (current ? 230 : 160);
            if (current) color = new int[] { 255, 255, 255 };
            float size = current ? 0.28F : (node.anchor ? 0.20F : 0.14F);
            diamond(buffer, node.x, node.y + 0.03, node.z, size, color, alpha);
            tess.draw();
            if (node.anchor || current) {
                float height = current ? 1.15F : 0.7F;
                buffer.begin(GL11.GL_LINES, DefaultVertexFormats.POSITION_COLOR);
                buffer.pos(node.x, node.y + 0.03, node.z).color(color[0], color[1], color[2], alpha).endVertex();
                buffer.pos(node.x, node.y + height, node.z).color(color[0], color[1], color[2], 40).endVertex();
                tess.draw();
            }
        }

        if (snap.goal != null) {
            column(buffer, snap.goal[0], snap.goal[1], snap.goal[2], 0.22, 1.7, new int[] { 80, 230, 120 }, 200);
            tess.draw();
        }

        if (snap.bot != null && snap.active) {
            ring(buffer, snap.bot[0], snap.bot[1] + 0.04, snap.bot[2], 0.35, new int[] { 255, 255, 255 }, 180);
            tess.draw();
            PathSnapshot.Node aim = aimNode(nodes, cursor);
            if (aim != null) {
                buffer.begin(GL11.GL_LINES, DefaultVertexFormats.POSITION_COLOR);
                buffer.pos(snap.bot[0], snap.bot[1] + 0.08, snap.bot[2]).color(255, 255, 255, 120).endVertex();
                buffer.pos(aim.x, aim.y + LIFT, aim.z).color(255, 255, 255, 40).endVertex();
                tess.draw();
            }
        }
    }

    private static PathSnapshot.Node aimNode (List<PathSnapshot.Node> nodes, int cursor) {
        if (nodes.isEmpty()) return null;
        for (PathSnapshot.Node node : nodes) {
            if (node.index == cursor) return node;
        }
        return cursor >= nodes.size() ? nodes.get(nodes.size() - 1) : nodes.get(0);
    }

    private static int segmentAlpha (int index, int cursor) {
        if (index + 1 < cursor) return 55;
        if (index + 1 == cursor) return 230;
        return 170;
    }

    private static boolean arcs (String kind, PathSnapshot.Node a, PathSnapshot.Node b) {
        if (kind.equals("gap") || kind.equals("jumpUp") || kind.equals("drop")) return true;
        return Math.abs(b.y - a.y) > 0.75;
    }

    private static void diamond (WorldRenderer buffer, double x, double y, double z, float size, int[] color, int alpha) {
        buffer.begin(GL11.GL_TRIANGLE_FAN, DefaultVertexFormats.POSITION_COLOR);
        buffer.pos(x, y, z).color(color[0], color[1], color[2], alpha).endVertex();
        buffer.pos(x + size, y, z).color(color[0], color[1], color[2], alpha).endVertex();
        buffer.pos(x, y, z + size).color(color[0], color[1], color[2], alpha).endVertex();
        buffer.pos(x - size, y, z).color(color[0], color[1], color[2], alpha).endVertex();
        buffer.pos(x, y, z - size).color(color[0], color[1], color[2], alpha).endVertex();
        buffer.pos(x + size, y, z).color(color[0], color[1], color[2], alpha).endVertex();
    }

    private static void column (WorldRenderer buffer, double x, double y, double z, double half, double height, int[] color, int alpha) {
        buffer.begin(GL11.GL_LINES, DefaultVertexFormats.POSITION_COLOR);
        double[][] corners = {
            { x - half, z - half },
            { x + half, z - half },
            { x + half, z + half },
            { x - half, z + half }
        };
        for (int i = 0; i < 4; i++) {
            double[] a = corners[i];
            double[] b = corners[(i + 1) % 4];
            line(buffer, a[0], y, a[1], b[0], y, b[1], color, alpha);
            line(buffer, a[0], y + height, a[1], b[0], y + height, b[1], color, alpha);
            line(buffer, a[0], y, a[1], a[0], y + height, a[1], color, alpha);
        }
    }

    private static void ring (WorldRenderer buffer, double x, double y, double z, double radius, int[] color, int alpha) {
        buffer.begin(GL11.GL_LINE_LOOP, DefaultVertexFormats.POSITION_COLOR);
        int steps = 16;
        for (int i = 0; i < steps; i++) {
            double a = i * Math.PI * 2 / steps;
            buffer.pos(x + Math.cos(a) * radius, y, z + Math.sin(a) * radius).color(color[0], color[1], color[2], alpha).endVertex();
        }
    }

    private static void line (WorldRenderer buffer, double x0, double y0, double z0, double x1, double y1, double z1, int[] color, int alpha) {
        buffer.pos(x0, y0, z0).color(color[0], color[1], color[2], alpha).endVertex();
        buffer.pos(x1, y1, z1).color(color[0], color[1], color[2], alpha).endVertex();
    }

    private static int[] colorFor (String kind) {
        if (kind == null) return new int[] { 180, 180, 180 };
        if (kind.equals("gap")) return new int[] { 255, 196, 64 };
        if (kind.equals("jumpUp")) return new int[] { 255, 140, 48 };
        if (kind.equals("drop")) return new int[] { 120, 170, 255 };
        if (kind.equals("ladderEnter") || kind.equals("climb") || kind.equals("climbDown") || kind.equals("ladderExit")) {
            return new int[] { 80, 220, 130 };
        }
        if (kind.equals("swim") || kind.equals("swimExit")) return new int[] { 60, 150, 255 };
        if (kind.equals("step")) return new int[] { 150, 220, 255 };
        return new int[] { 90, 210, 255 };
    }

    private static final class Vert {
        final double x;
        final double y;
        final double z;
        final int r;
        final int g;
        final int b;
        final int a;

        Vert (double x, double y, double z, int[] color, int alpha) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.r = color[0];
            this.g = color[1];
            this.b = color[2];
            this.a = alpha;
        }
    }
}
